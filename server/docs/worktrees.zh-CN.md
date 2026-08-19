# PiHub 中的 Git Worktree

PiHub 把同一 Git 仓库的 main checkout 和 linked worktree 视为同一个项目，并在工作台标题旁提供切换器。切换 worktree 会为新的工作创建或打开对应 checkout，不会改写已有会话记录的工作目录。

## 显示条件

选中的会话位于 Git 仓库时，PiHub 会读取该仓库的 worktree 列表：

- 位于仓库根目录时，切换器直接显示当前 checkout。
- 位于仓库子目录时仍可切换，但切换后从目标 worktree 根目录创建新会话。
- 非 Git 目录、Git 命令失败或项目尚未受信任时，不提供可执行的 worktree 管理操作。

项目级 Git 操作可能触发 hook 或读取项目配置。首次管理前，Server 会要求通过项目信任确认。

## 切换

打开标题旁的分支菜单并选择目标 checkout。PiHub 会：

1. 把工作区文件与 Git 状态切换到目标路径；
2. 尝试打开该 checkout 最近的会话；
3. 没有历史会话时，在目标 worktree 根目录创建新会话。

已有会话仍记住创建时的 `cwd`。重新打开某个旧会话时，文件浏览和 Git 面板会回到该会话所属的 checkout。

## 新建

在 worktree 菜单选择“新建 worktree”，输入合法的 Git branch name。

Server 使用 Git 的 worktree 机制创建 checkout：

- branch 已存在时，为该 branch 添加 worktree；
- branch 不存在时，从当前 `HEAD` 创建 branch 和 worktree；
- 同一 branch 已被其他 worktree checkout 时，Git 会拒绝重复创建。

创建成功后，PiHub 立即打开该 worktree。路径由 Server 的安全规则生成并校验，客户端不能指定任意目标目录。

## 移除

main checkout 不能通过 PiHub 移除。对 linked worktree 选择“移除”时：

- 删除的是 checkout 目录，不删除 Git branch；
- 历史会话保留，其原始 `cwd` 仍可用于定位上下文；
- 存在未提交或未跟踪文件时，普通移除会被拒绝；
- 只有用户在第二次危险确认中明确同意，才会执行 force remove。

Force remove 会永久丢弃该 checkout 中尚未提交的文件。执行前应先提交、移动或备份需要保留的内容。

## 安全边界

- 所有 worktree API 都要求已认证设备、`workspaces:manage` capability 和可信项目。
- Git 命令通过参数数组执行，不拼接 shell 命令。
- Server 校验 repository root、worktree path、branch 名称、符号链接和删除范围。
- 目标 checkout 不会自动继承另一个设备的会话访问权；会话仍按 device owner 隔离。

## 常见问题

**为什么没有 worktree 菜单？**

确认当前会话目录属于 Git 仓库，并完成项目信任。如果 Git 元数据损坏或 Server 无权读取仓库，工作台会显示对应错误。

**为什么不能创建某个 branch？**

Git 不允许同一个 branch 同时被多个 worktree checkout。请切换到已有 checkout，或先安全移除它。

**移除后为什么会话还在？**

移除 checkout 与删除会话是不同操作。PiHub 保留会话和 branch，避免文件目录操作意外删除对话历史。

**切换后为什么从仓库根目录开始？**

当前会话位于仓库子目录时，目标 worktree 中未必存在同一子目录；PiHub 因此从经过验证的 worktree 根目录开始新会话。
