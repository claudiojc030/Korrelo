import { Inject, Logger } from "@nestjs/common";
import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
  SubscribeMessage,
  WebSocketGateway,
} from "@nestjs/websockets";
import type { Socket } from "socket.io";
import { PROJECT_REPOSITORY, type ProjectRepository } from "../../projects/domain/project.repository";
import { SHELL_SESSION_FACTORY, type ShellSessionFactory, type ShellSession } from "../domain/shell-session";
import { TOKEN_SERVICE, type TokenService } from "../../auth/domain/token-service";

interface StartPayload {
  projectId: string;
}

@WebSocketGateway({ namespace: "/terminal", cors: { origin: "*" } })
export class TerminalGateway implements OnGatewayConnection, OnGatewayDisconnect {
  private readonly logger = new Logger(TerminalGateway.name);
  private readonly sessions = new Map<string, ShellSession>();

  constructor(
    @Inject(PROJECT_REPOSITORY) private readonly projectRepository: ProjectRepository,
    @Inject(SHELL_SESSION_FACTORY) private readonly shellSessionFactory: ShellSessionFactory,
    @Inject(TOKEN_SERVICE) private readonly tokenService: TokenService,
  ) {}

  handleConnection(client: Socket): void {
    // O token vem do handshake (auth.token), não de um header HTTP — o guard
    // global de HTTP não cobre WebSocket, então validamos aqui manualmente.
    const token = client.handshake.auth?.token as string | undefined;
    const payload = token ? this.tokenService.verify(token) : null;

    if (!payload) {
      client.emit("error", "Não autenticado.");
      client.disconnect();
    }
  }

  @SubscribeMessage("start")
  async handleStart(@ConnectedSocket() client: Socket, @MessageBody() payload: StartPayload): Promise<void> {
    const project = await this.projectRepository.findById(payload.projectId);
    if (!project || !project.containerName || project.status !== "running") {
      client.emit("error", "Projeto não encontrado ou não está rodando.");
      client.disconnect();
      return;
    }

    const session = this.shellSessionFactory.spawn(project.containerName);
    this.sessions.set(client.id, session);

    session.onData((data) => client.emit("output", data));
    session.onExit((code) => {
      client.emit("exit", code);
      client.disconnect();
    });
  }

  @SubscribeMessage("input")
  handleInput(@ConnectedSocket() client: Socket, @MessageBody() data: string): void {
    this.sessions.get(client.id)?.write(data);
  }

  handleDisconnect(client: Socket): void {
    this.sessions.get(client.id)?.kill();
    this.sessions.delete(client.id);
    this.logger.log(`Sessão de terminal encerrada: ${client.id}`);
  }
}
