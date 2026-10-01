import { createHash, randomUUID } from "node:crypto";
import * as net from "node:net";
import * as vscode from "vscode";

interface PeerState {
  focused: boolean;
  lastSeen: number;
}

export class WindowLease implements vscode.Disposable {
  public readonly instanceId = randomUUID();
  private readonly pipeName: string;
  private server?: net.Server;
  private follower?: net.Socket;
  private heartbeatTimer?: NodeJS.Timeout;
  private retryTimer?: NodeJS.Timeout;
  private peers = new Map<string, PeerState>();
  private peerSockets = new Set<net.Socket>();
  private socketPeers = new Map<net.Socket, string>();
  private owner = false;
  private disposed = false;

  public constructor(
    workspaceUri: string,
    private readonly focused: () => boolean,
    private readonly onOwnerChanged: (owner: boolean) => void,
    private readonly log: (...parts: string[]) => void,
  ) {
    const key = createHash("sha256")
      .update(workspaceUri)
      .digest("hex")
      .slice(0, 24);
    this.pipeName = `\\\\.\\pipe\\jzhg6.claude-remote-notifier.${key}`;
  }

  public start(): void {
    this.tryBecomeOwner();
  }

  public isOwner(): boolean {
    return this.owner;
  }

  public anyWindowFocused(): boolean {
    this.prunePeers();
    if (this.owner && this.focused()) return true;
    return [...this.peers.values()].some((peer) => peer.focused);
  }

  public sendFocusUpdate(): void {
    if (this.follower && !this.follower.destroyed)
      this.writeHeartbeat(this.follower);
  }

  public dispose(): void {
    this.disposed = true;
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.follower?.destroy();
    for (const socket of this.peerSockets) socket.destroy();
    this.peerSockets.clear();
    this.socketPeers.clear();
    const server = this.server;
    this.server = undefined;
    if (server) {
      if (server.listening) server.close();
      else server.once("listening", () => server.close());
    }
    this.peers.clear();
  }

  private tryBecomeOwner(): void {
    if (this.disposed) return;
    const server = net.createServer((socket) => this.acceptPeer(socket));
    this.server = server;
    server.once("error", () => {
      if (this.server === server) this.server = undefined;
      if (!this.disposed) this.connectToOwner();
    });
    server.listen(this.pipeName, () => {
      if (this.disposed) {
        server.close();
        return;
      }
      this.setOwner(true);
      this.log("acquired local window lease");
    });
  }

  private connectToOwner(): void {
    if (this.disposed) return;
    const socket = net.connect(this.pipeName);
    this.follower = socket;
    socket.once("connect", () => {
      this.setOwner(false);
      this.writeHeartbeat(socket);
      this.heartbeatTimer = setInterval(
        () => this.writeHeartbeat(socket),
        2000,
      );
      this.log("joined existing local window lease");
    });
    socket.once("error", () => socket.destroy());
    socket.once("close", () => {
      if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
      this.follower = undefined;
      if (!this.disposed) {
        this.retryTimer = setTimeout(
          () => this.tryBecomeOwner(),
          250 + Math.random() * 750,
        );
      }
    });
  }

  private acceptPeer(socket: net.Socket): void {
    this.peerSockets.add(socket);
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("error", () => socket.destroy());
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      if (buffer.length > 4096) {
        socket.destroy();
        return;
      }
      for (;;) {
        const newline = buffer.indexOf("\n");
        if (newline < 0) break;
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        try {
          const message = JSON.parse(line) as {
            instanceId?: string;
            focused?: boolean;
          };
          if (
            typeof message.instanceId === "string" &&
            message.instanceId.length <= 64
          ) {
            this.peers.set(message.instanceId, {
              focused: message.focused === true,
              lastSeen: Date.now(),
            });
            this.socketPeers.set(socket, message.instanceId);
          }
        } catch {}
      }
    });
    socket.on("close", () => {
      const instanceId = this.socketPeers.get(socket);
      if (instanceId) this.peers.delete(instanceId);
      this.socketPeers.delete(socket);
      this.peerSockets.delete(socket);
      this.prunePeers();
    });
  }

  private writeHeartbeat(socket: net.Socket): void {
    try {
      socket.write(
        JSON.stringify({
          instanceId: this.instanceId,
          focused: this.focused(),
        }) + "\n",
      );
    } catch {}
  }

  private prunePeers(): void {
    const cutoff = Date.now() - 7000;
    for (const [id, peer] of this.peers) {
      if (peer.lastSeen < cutoff) this.peers.delete(id);
    }
  }

  private setOwner(owner: boolean): void {
    if (this.owner === owner) return;
    this.owner = owner;
    this.onOwnerChanged(owner);
  }
}
