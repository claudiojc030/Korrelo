/**
 * Lock em memória para a RECONCILIAÇÃO explícita de projeto.
 *
 * O Image GC deve recusar `apply` enquanto uma reconciliação estiver em
 * andamento (o estado do banco/container pode mudar no meio da coleta).
 * É apenas coordenação local do processo; não persiste e não altera dados.
 */
let reconciling = 0;

export function beginReconciliation(): void {
  reconciling += 1;
}

export function endReconciliation(): void {
  reconciling = Math.max(0, reconciling - 1);
}

export function isReconciling(): boolean {
  return reconciling > 0;
}
