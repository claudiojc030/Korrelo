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
import type { ShellSession } from "../domain/shell-session";
import { HostShellSessionFactory } from "../infrastructure/host-shell-session";
import { TOKEN_SERVICE, type TokenService } from "../../auth/domain/token-service";
import { TOKEN_COOKIE } from "../../auth/presentation/token-cookie";
import { getAllowedOrigins } from "../infrastructure/allowed-origins";

// Terminal da VPS inteira (o host onde o Core roda), diferente do terminal
// por projeto (que roda via `docker exec` isolado no container). Um shell
// aqui tem o mesmo alcance do processo Core: todos os projetos, backups,
// configs de nginx etc, só que ainda sem privilégio de root.
@WebSocketGateway({ namespace: "/system-terminal", cors: { origin: getAllowedOrigins(), credentials: true } })
export class SystemTerminalGateway implements OnGatewayConnection, OnGatewayDisconnect {
  private readonly logger = new Logger(SystemTerminalGateway.name);
  private readonly sessions = new Map<string, ShellSession>();

  constructor(
    private readonly hostShellSessionFactory: HostShellSessionFactory,
    @Inject(TOKEN_SERVICE) private readonly tokenService: TokenService,
  ) {}

  handleConnection(client: Socket): void {
    const cookieHeader = client.handshake.headers.cookie;
    const token = cookieHeader ? cookie.parse(cookieHeader)[TOKEN_COOKIE] : undefined;
    const payload = token ? this.tokenService.verify(token) : null;

    if (!payload) {
      client.emit("error", "Não autenticado.");
      client.disconnect();
    }
  }

  @SubscribeMessage("start")
  handleStart(@ConnectedSocket() client: Socket): void {
    this.logger.log(`Sessão de terminal da VPS iniciada: ${client.id}`);
    const session = this.hostShellSessionFactory.spawn();
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
    this.logger.log(`Sessão de terminal da VPS encerrada: ${client.id}`);
  }
}
