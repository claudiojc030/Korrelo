export interface StorageDict {
  pageTitle: string;
  pageDescription: string;
  loading: string;
  loadError: string;
  analyze: string;
  analyzing: string;
  clean: string;
  cleaning: string;
  cleanConfirmTitle: string;
  cleanConfirmBody: string;
  cleanConfirmYes: string;
  cleanConfirmNo: string;
  cleanDone: string;
  cleanFailed: string;
  cleanSummaryTitle: string;
  cleanSummaryItems: string;
  cleanSummaryFreed: string;
  cleanSummaryFailures: string;
  cleanSummaryFreeBefore: string;
  cleanSummaryFreeAfter: string;
  cardUsed: string;
  cardFree: string;
  cardSafe: string;
  cardReview: string;
  cardKeep: string;
  cardNever: string;
  filterAll: string;
  filterSafe: string;
  filterReview: string;
  filterKeep: string;
  filterNever: string;
  filterCategoryAll: string;
  filterCategoryDocker: string;
  filterCategoryBuildCache: string;
  filterCategoryBackups: string;
  filterCategorySelfUpdate: string;
  filterCategoryLogs: string;
  filterCategoryCaches: string;
  filterCategoryTemp: string;
  filterCategoryOther: string;
  itemsTitle: string;
  itemsEmpty: string;
  columnName: string;
  columnCategory: string;
  columnSize: string;
  columnClassification: string;
  columnReason: string;
  columnAction: string;
  details: string;
  detailsPath: string;
  detailsReason: string;
  detailsCommand: string;
  detailsProtections: string;
  noAction: string;
  noItems: string;
  protectNotice: string;
  badgeSafe: string;
  badgeReview: string;
  badgeKeep: string;
  badgeNever: string;
}

export const storageEn: StorageDict = {
  pageTitle: "Storage",
  pageDescription:
    "Analyze the VPS disk usage and remove only the items Korrelo considers safe.",
  loading: "Analyzing VPS storage...",
  loadError: "Couldn't analyze the VPS storage.",
  analyze: "Analyze cleanup",
  analyzing: "Analyzing...",
  clean: "Clean safe items",
  cleaning: "Cleaning...",
  cleanConfirmTitle: "Clean safe items?",
  cleanConfirmBody:
    "Only items classified as SAFE TO CLEAN will be removed. Protected items (production, databases, current/rollback images, newest backup) are never touched.",
  cleanConfirmYes: "Clean now",
  cleanConfirmNo: "Cancel",
  cleanDone: "Cleanup finished.",
  cleanFailed: "Cleanup failed.",
  cleanSummaryTitle: "Cleanup summary",
  cleanSummaryItems: "Items removed",
  cleanSummaryFreed: "Space freed",
  cleanSummaryFailures: "Failures",
  cleanSummaryFreeBefore: "Free before",
  cleanSummaryFreeAfter: "Free after",
  cardUsed: "Disk used",
  cardFree: "Free space",
  cardSafe: "Safe to clean",
  cardReview: "Review",
  cardKeep: "Keep",
  cardNever: "Never touch",
  filterAll: "All",
  filterSafe: "Safe to clean",
  filterReview: "Review",
  filterKeep: "Keep",
  filterNever: "Never touch",
  filterCategoryAll: "All categories",
  filterCategoryDocker: "Docker",
  filterCategoryBuildCache: "Build cache",
  filterCategoryBackups: "Backups",
  filterCategorySelfUpdate: "Self-update",
  filterCategoryLogs: "Logs",
  filterCategoryCaches: "Caches",
  filterCategoryTemp: "Temporary files",
  filterCategoryOther: "Others",
  itemsTitle: "Found items",
  itemsEmpty: "Nothing matches these filters.",
  columnName: "Name",
  columnCategory: "Category",
  columnSize: "Size",
  columnClassification: "Classification",
  columnReason: "Reason",
  columnAction: "Proposed action",
  details: "Details",
  detailsPath: "Path / resource",
  detailsReason: "Why this classification",
  detailsCommand: "Command that would be used",
  detailsProtections: "Detected protections",
  noAction: "No action (protected)",
  noItems: "No items found.",
  protectNotice:
    "Protected items were found (production containers, databases, current/rollback images, newest backup). They are never removed automatically.",
  badgeSafe: "SAFE TO CLEAN",
  badgeReview: "REVIEW",
  badgeKeep: "KEEP",
  badgeNever: "NEVER TOUCH",
};

export const storagePt: StorageDict = {
  pageTitle: "Armazenamento",
  pageDescription:
    "Analise o uso de disco da VPS e remova somente os itens considerados seguros pelo Korrelo.",
  loading: "Analisando armazenamento da VPS...",
  loadError: "Não foi possível analisar o armazenamento da VPS.",
  analyze: "Analisar limpeza",
  analyzing: "Analisando...",
  clean: "Limpar itens seguros",
  cleaning: "Limpando...",
  cleanConfirmTitle: "Limpar itens seguros?",
  cleanConfirmBody:
    "Só itens classificados como SAFE TO CLEAN serão removidos. Itens protegidos (produção, bancos, imagens CURRENT/rollback, backup mais recente) nunca são tocados.",
  cleanConfirmYes: "Limpar agora",
  cleanConfirmNo: "Cancelar",
  cleanDone: "Limpeza concluída.",
  cleanFailed: "A limpeza falhou.",
  cleanSummaryTitle: "Resumo da limpeza",
  cleanSummaryItems: "Itens removidos",
  cleanSummaryFreed: "Espaço recuperado",
  cleanSummaryFailures: "Falhas",
  cleanSummaryFreeBefore: "Livre antes",
  cleanSummaryFreeAfter: "Livre depois",
  cardUsed: "Disco usado",
  cardFree: "Espaço livre",
  cardSafe: "Seguro para limpar",
  cardReview: "Precisa de revisão",
  cardKeep: "Manter",
  cardNever: "Nunca tocar",
  filterAll: "Todos",
  filterSafe: "Seguro para limpar",
  filterReview: "Revisão",
  filterKeep: "Manter",
  filterNever: "Nunca tocar",
  filterCategoryAll: "Todas as categorias",
  filterCategoryDocker: "Docker",
  filterCategoryBuildCache: "Cache de build",
  filterCategoryBackups: "Backups",
  filterCategorySelfUpdate: "Self-update",
  filterCategoryLogs: "Logs",
  filterCategoryCaches: "Caches",
  filterCategoryTemp: "Temporários",
  filterCategoryOther: "Outros",
  itemsTitle: "Itens encontrados",
  itemsEmpty: "Nada corresponde a estes filtros.",
  columnName: "Nome",
  columnCategory: "Categoria",
  columnSize: "Tamanho",
  columnClassification: "Classificação",
  columnReason: "Motivo",
  columnAction: "Ação proposta",
  details: "Detalhes",
  detailsPath: "Caminho / recurso",
  detailsReason: "Por que esta classificação",
  detailsCommand: "Comando que seria usado",
  detailsProtections: "Proteções detectadas",
  noAction: "Sem ação (protegido)",
  noItems: "Nenhum item encontrado.",
  protectNotice:
    "Itens protegidos foram encontrados (containers de produção, bancos, imagens CURRENT/rollback, backup mais recente). Eles nunca são removidos automaticamente.",
  badgeSafe: "SEGURO PARA LIMPAR",
  badgeReview: "REVISÃO",
  badgeKeep: "MANTER",
  badgeNever: "NUNCA TOCAR",
};
