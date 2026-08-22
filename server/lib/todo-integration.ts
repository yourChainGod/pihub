/**
 * TodoList Integration for PiHub
 *
 * 集成 pi-todo-rail 插件，将待办事项功能暴露给前端 UI。
 *
 * 功能：
 * - 实时同步待办事项
 * - 前端 API 接口
 * - WebSocket 推送更新
 * - 与 Pi Agent 的待办系统联动
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, watchFile, unwatchFile } from "fs";
import { homedir } from "os";
import { join } from "path";
import { EventEmitter } from "events";

export interface TodoItem {
  id: string;
  task: string;
  priority: "high" | "medium" | "low";
  completed: boolean;
  createdAt: string;
  completedAt?: string;
  tags?: string[];
  project?: string;
}

export interface TodoListData {
  version: string;
  todos: TodoItem[];
  lastModified: string;
}

/**
 * PiHub Todo 集成
 *
 * 管理待办事项，同步 pi-todo-rail 数据
 */
export class PihubTodoIntegration extends EventEmitter {
  private dataPath: string;
  private syncInterval: number;
  private syncTimer: NodeJS.Timeout | null = null;
  private watcherEnabled: boolean;

  constructor(options?: { dataPath?: string; syncInterval?: number; enableWatcher?: boolean }) {
    super();

    const dataRoot = join(homedir(), ".pihub");
    this.dataPath = options?.dataPath || join(dataRoot, "todos.json");
    this.syncInterval = options?.syncInterval ?? 5000;
    this.watcherEnabled = options?.enableWatcher ?? true;

    this.ensureDataFile();
  }

  /**
   * 确保数据文件存在
   */
  private ensureDataFile(): void {
    const dataDir = join(this.dataPath, "..");

    if (!existsSync(dataDir)) {
      mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    }

    if (!existsSync(this.dataPath)) {
      const initialData: TodoListData = {
        version: "1.0",
        todos: [],
        lastModified: new Date().toISOString(),
      };
      this.saveData(initialData);
    }
  }

  /**
   * 加载待办数据
   */
  private loadData(): TodoListData {
    try {
      const content = readFileSync(this.dataPath, "utf8");
      return JSON.parse(content);
    } catch (error) {
      console.error("[todo] Failed to load data:", error);
      return {
        version: "1.0",
        todos: [],
        lastModified: new Date().toISOString(),
      };
    }
  }

  /**
   * 保存待办数据
   */
  private saveData(data: TodoListData): void {
    data.lastModified = new Date().toISOString();
    const content = JSON.stringify(data, null, 2);
    writeFileSync(this.dataPath, content, { encoding: "utf8", mode: 0o600 });
    this.emit("updated", data.todos);
  }

  /**
   * 启动同步
   */
  start(): void {
    // 定时同步
    if (this.syncInterval > 0) {
      this.syncTimer = setInterval(() => {
        this.emit("sync", this.loadData().todos);
      }, this.syncInterval);
    }

    // 文件监听
    if (this.watcherEnabled) {
      watchFile(this.dataPath, { interval: 1000 }, () => {
        const data = this.loadData();
        this.emit("changed", data.todos);
      });
    }

    console.log("[todo] ✓ Started todo integration");
  }

  /**
   * 停止同步
   */
  stop(): void {
    if (this.syncTimer) {
      clearInterval(this.syncTimer);
      this.syncTimer = null;
    }

    if (this.watcherEnabled) {
      unwatchFile(this.dataPath);
    }

    console.log("[todo] Stopped todo integration");
  }

  /**
   * 获取所有待办事项
   */
  async getTodos(): Promise<TodoItem[]> {
    const data = this.loadData();
    return data.todos;
  }

  /**
   * 添加待办事项
   */
  async addTodo(task: string, priority: TodoItem["priority"] = "medium", options?: {
    tags?: string[];
    project?: string;
  }): Promise<TodoItem> {
    const data = this.loadData();

    const newTodo: TodoItem = {
      id: `todo-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      task,
      priority,
      completed: false,
      createdAt: new Date().toISOString(),
      tags: options?.tags,
      project: options?.project,
    };

    data.todos.push(newTodo);
    this.saveData(data);

    return newTodo;
  }

  /**
   * 完成待办事项
   */
  async completeTodo(id: string): Promise<TodoItem | null> {
    const data = this.loadData();
    const todo = data.todos.find((t) => t.id === id);

    if (!todo) return null;

    todo.completed = true;
    todo.completedAt = new Date().toISOString();
    this.saveData(data);

    return todo;
  }

  /**
   * 删除待办事项
   */
  async deleteTodo(id: string): Promise<boolean> {
    const data = this.loadData();
    const index = data.todos.findIndex((t) => t.id === id);

    if (index === -1) return false;

    data.todos.splice(index, 1);
    this.saveData(data);

    return true;
  }

  /**
   * 更新待办事项
   */
  async updateTodo(id: string, updates: Partial<Omit<TodoItem, "id" | "createdAt">>): Promise<TodoItem | null> {
    const data = this.loadData();
    const todo = data.todos.find((t) => t.id === id);

    if (!todo) return null;

    Object.assign(todo, updates);
    this.saveData(data);

    return todo;
  }

  /**
   * 获取未完成的待办事项
   */
  async getActiveTodos(): Promise<TodoItem[]> {
    const todos = await this.getTodos();
    return todos.filter((t) => !t.completed);
  }

  /**
   * 按优先级排序
   */
  async getTodosByPriority(): Promise<TodoItem[]> {
    const todos = await this.getTodos();
    const priorityOrder = { high: 0, medium: 1, low: 2 };

    return todos.sort((a, b) => {
      if (a.completed !== b.completed) {
        return a.completed ? 1 : -1;
      }
      return priorityOrder[a.priority] - priorityOrder[b.priority];
    });
  }

  /**
   * 统计数据
   */
  async getStats(): Promise<{
    total: number;
    active: number;
    completed: number;
    byPriority: Record<TodoItem["priority"], number>;
  }> {
    const todos = await this.getTodos();

    return {
      total: todos.length,
      active: todos.filter((t) => !t.completed).length,
      completed: todos.filter((t) => t.completed).length,
      byPriority: {
        high: todos.filter((t) => t.priority === "high" && !t.completed).length,
        medium: todos.filter((t) => t.priority === "medium" && !t.completed).length,
        low: todos.filter((t) => t.priority === "low" && !t.completed).length,
      },
    };
  }

  /**
   * 清理已完成的待办事项（超过指定天数）
   */
  async cleanupCompleted(daysOld = 7): Promise<number> {
    const data = this.loadData();
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - daysOld);

    const initialCount = data.todos.length;

    data.todos = data.todos.filter((todo) => {
      if (!todo.completed || !todo.completedAt) return true;
      const completedDate = new Date(todo.completedAt);
      return completedDate > cutoffDate;
    });

    const removed = initialCount - data.todos.length;

    if (removed > 0) {
      this.saveData(data);
    }

    return removed;
  }
}

/**
 * 全局 Todo 集成实例
 */
let todoIntegration: PihubTodoIntegration | null = null;

/**
 * 获取或创建 Todo 集成实例
 */
export function getTodoIntegration(options?: {
  dataPath?: string;
  syncInterval?: number;
}): PihubTodoIntegration {
  if (!todoIntegration) {
    todoIntegration = new PihubTodoIntegration(options);
    todoIntegration.start();
  }
  return todoIntegration;
}

/**
 * 清理 Todo 集成
 */
export function cleanupTodoIntegration(): void {
  if (todoIntegration) {
    todoIntegration.stop();
    todoIntegration.removeAllListeners();
    todoIntegration = null;
  }
}
