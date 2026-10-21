"use strict";

/**
 * SANITIZAÇÃO DE SEGREDOS EM MENSAGEM/ERRO.
 *
 * Regra: senha (e URI com senha) NUNCA aparece em log, erro, manifesto
 * ou mensagem pro painel. Antes de qualquer texto sair do motor de
 * backup, ele passa por aqui.
 */

const URI_CREDENTIALS = /([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)([^\s/:@]+):([^\s/@]+)@/g;
const PASSWORD_FLAG = /(--password[= ])([^\s"']+)/g;

/**
 * Remove segredos de um texto.
 *
 * @param {string} text
 * @param {string[]} [secrets] valores literais a esconder (senha, token...)
 * @returns {string}
 */
function redact(text, secrets = []) {
  if (text === null || text === undefined) return "";
  let output = String(text);

  for (const secret of secrets) {
    if (!secret || typeof secret !== "string" || secret.length < 3) continue;
    output = output.split(secret).join("***");
  }

  // mongodb://user:senha@host -> mongodb://user:***@host
  output = output.replace(URI_CREDENTIALS, "$1$2:***@");
  // --password senha -> --password ***
  output = output.replace(PASSWORD_FLAG, "$1***");

  return output;
}

/**
 * Sanitiza um objeto de erro (message/stderr) antes de devolver.
 */
function redactError(error, secrets = []) {
  if (!error) return null;
  if (typeof error === "string") return redact(error, secrets);
  const message = error instanceof Error ? error.message : String(error);
  const sanitized = new Error(redact(message, secrets));
  if (error.stack) sanitized.stack = redact(error.stack, secrets);
  if (error.code) sanitized.code = error.code;
  return sanitized;
}

module.exports = {
  redact,
  redactError,
};
