import { Injectable, InternalServerErrorException } from "@nestjs/common";
import * as crypto from "node:crypto";
import { apiError } from "../api-error";

const ALGORITHM = "aes-256-gcm";
const PREFIX = "enc:v1:";

// Variáveis de ambiente de projeto costumam guardar segredos de verdade
// (chaves de API, connection strings), por isso ficam cifradas em repouso no
// banco do Core, não em texto puro. Valores gravados antes dessa mudança não
// têm o prefixo "enc:v1:" e continuam sendo lidos como estão (decrypt tenta,
// cai pro texto original se não reconhecer o formato); a próxima gravação já cifra.
@Injectable()
export class EnvVarCipher {
  private get key(): Buffer {
    const hex = process.env.ENV_ENCRYPTION_KEY;
    if (!hex) {
      throw new InternalServerErrorException(apiError("ENV_ENCRYPTION_KEY_MISSING", "ENV_ENCRYPTION_KEY não configurado"));
    }
    const key = Buffer.from(hex, "hex");
    if (key.length !== 32) {
      throw new InternalServerErrorException(
        apiError("ENV_ENCRYPTION_KEY_INVALID_LENGTH", "ENV_ENCRYPTION_KEY precisa ter 32 bytes (64 caracteres hex)"),
      );
    }
    return key;
  }

  isEncrypted(storedValue: string): boolean {
    return storedValue.startsWith(PREFIX);
  }

  encrypt(plainText: string): string {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv(ALGORITHM, this.key, iv);
    const ciphertext = Buffer.concat([cipher.update(plainText, "utf-8"), cipher.final()]);
    const authTag = cipher.getAuthTag();
    return `${PREFIX}${iv.toString("hex")}:${authTag.toString("hex")}:${ciphertext.toString("hex")}`;
  }

  decrypt(storedValue: string): string {
    if (!storedValue.startsWith(PREFIX)) {
      // Valor legado (gravado antes da cifragem existir). Devolve como está.
      return storedValue;
    }
    try {
      const [, , ivHex, authTagHex, ciphertextHex] = storedValue.split(":");
      const decipher = crypto.createDecipheriv(ALGORITHM, this.key, Buffer.from(ivHex, "hex"));
      decipher.setAuthTag(Buffer.from(authTagHex, "hex"));
      const plaintext = Buffer.concat([
        decipher.update(Buffer.from(ciphertextHex, "hex")),
        decipher.final(),
      ]);
      return plaintext.toString("utf-8");
    } catch {
      throw new InternalServerErrorException(
        apiError(
          "ENV_VAR_DECRYPT_FAILED",
          "Falha ao decifrar variável de ambiente. ENV_ENCRYPTION_KEY pode estar errado.",
        ),
      );
    }
  }
}
