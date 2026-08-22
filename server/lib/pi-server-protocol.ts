/**
 * IPC Protocol between PiHub Server and Pi Agent (out-of-process)
 *
 * This protocol enables PiHub Server to communicate with an independent
 * Pi Agent process via Node.js IPC channel.
 */

export interface PiServerProtocol {
  // Session lifecycle management
  "session:create": {
    request: {
      sessionId: string;
      sessionFile?: string;
      cwd: string;
      config: {
        toolNames?: string[];
        initialModel?: { provider: string; modelId: string };
        thinkingLevel?: string;
      };
    };
    response: {
      sessionId: string;
      success: boolean;
      error?: string;
    };
  };

  "session:message": {
    request: {
      sessionId: string;
      content: string;
      images?: Array<{ type: "image"; data: string; mimeType: string }>;
    };
    response: {
      success: boolean;
      error?: string;
    };
  };

  "session:stop": {
    request: {
      sessionId: string;
    };
    response: {
      success: boolean;
    };
  };

  "session:command": {
    request: {
      sessionId: string;
      command: Record<string, unknown>;
    };
    response: {
      result: unknown;
      error?: string;
    };
  };

  // Agent status queries
  "agent:status": {
    request: Record<string, never>;
    response: {
      version: string;
      ready: boolean;
    };
  };

  "agent:version": {
    request: Record<string, never>;
    response: {
      version: string;
      piVersion: string;
    };
  };

  // Extension management
  "extensions:list": {
    request: Record<string, never>;
    response: {
      extensions: Array<{
        name: string;
        version: string;
        enabled: boolean;
      }>;
    };
  };

  "extensions:install": {
    request: {
      name: string;
      source?: string;
    };
    response: {
      success: boolean;
      error?: string;
    };
  };

  "extensions:update": {
    request: {
      names?: string[];
    };
    response: {
      updated: string[];
      failed: Array<{ name: string; error: string }>;
    };
  };
}

export type IpcMessageType = keyof PiServerProtocol;

export interface IpcRequest<T extends IpcMessageType = IpcMessageType> {
  id: string;
  type: "request";
  method: T;
  payload: PiServerProtocol[T]["request"];
}

export interface IpcResponse<T extends IpcMessageType = IpcMessageType> {
  id: string;
  type: "response";
  method: T;
  payload: PiServerProtocol[T]["response"];
  error?: string;
}

export interface IpcEvent {
  type: "event";
  event: string;
  data: Record<string, unknown>;
}

export type IpcMessage = IpcRequest | IpcResponse | IpcEvent;

export const IPC_PROTOCOL_VERSION = "pihub-pi-v1";
