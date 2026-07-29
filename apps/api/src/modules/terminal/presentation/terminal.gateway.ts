import { Inject, Logger } from "@nestjs/common";
import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
  SubscribeMessage,
  WebSocketGateway,
} from "@nestjs/websockets";
import cookie from "cookie";
import type { Socket } from "socket.io";
import { PROJECT_REPOSITORY, type ProjectRepository } from "../../projects/domain/project.repository";
import { SHELL_SESSION_FACTORY, type ShellSessionFactory, type ShellSession } from "../domain/shell-session";
import { TOKEN_SERVICE, type TokenService } from "../../auth/domain/token-service";
import { TOKEN_COOKIE } from "../../auth/presentation/token-cookie";

interface StartPayload {
  projectId: string;
}

function getAllowedOrigins(): string[] {
  const configured = process.env.CORS_ORIGINS;
  if (configured) return configured.split(",").map((origin) => origin.trim());
  return [process.env.KORRELO_WEB_URL ?? "http://localhost:3000"];
}

@WebSocketGateway({ namespace: "/terminal", cors: { origin: getAllowedOrigins(), credentials: true } })
export class TerminalGateway implements OnGatewayConnection, OnGatewayDisconnect {
  private readonly logger = new Logger(TerminalGateway.name);
  private readonly sessions = new Map<string, ShellSession>();

  constructor(
    @Inject(PROJECT_REPOSITORY) private readonly projectRepository: ProjectRepository,
    @Inject(SHELL_SESSION_FACTORY) private readonly shellSessionFactory: ShellSessionFactory,
    @Inject(TOKEN_SERVICE) private readonly tokenService: TokenService,
  ) {}

  handleConnection(client: Socket): void {
    // O guard global de HTTP não cobre WebSocket, então validamos aqui manualmente,
    // lendo o cookie httpOnly que o navegador manda junto do handshake
    // (socket.io client precisa de withCredentials: true pra isso).
    const cookieHeader = client.handshake.headers.cookie;
    const token = cookieHeader ? cookie.parse(cookieHeader)[TOKEN_COOKIE] : undefined;
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
