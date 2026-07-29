export interface ProjectDatabaseDict {
  typeLabelPostgres: string;
  typeLabelRedis: string;
  typeLabelMongodb: string;
  typeLabelCustom: string;
  disabledTitle: string;
  disabledSubtitle: string;
  emptyState: string;
  provisionError: string;
  unknownError: string;
  postgresDescription: string;
  redisDescription: string;
  mongodbDescription: string;
  redisPersistentLabel: string;
  provisionButtonTemplate: string;
  customDescription: string;
  connectExternalButton: string;
  envVarNameLabel: string;
  envVarNamePlaceholder: string;
  connectionStringLabel: string;
  connectionStringPlaceholder: string;
  connectButton: string;
  showPassword: string;
  hidePassword: string;
  envVarLabel: string;
  hostLabel: string;
  portLabel: string;
  usernameLabel: string;
  databaseNameLabel: string;
  passwordLabel: string;
  persistenceLabel: string;
  persistenceEnabled: string;
  persistenceDisabled: string;
  externalInfoPrefix: string;
  externalInfoSuffix: string;
  configuredInfoPrefix: string;
  configuredInfoMiddle: string;
  configuredInfoSuffix: string;
  removeDatabaseButton: string;
  remove: string;
  confirmRemoveTitle: string;
  confirmRemoveCustomBody: string;
  confirmRemoveBody: string;
  listTablesError: string;
  entityLabelCollections: string;
  entityLabelKeysSample: string;
  entityLabelTables: string;
  browserTitle: string;
  noneFoundYet: string;
  ctrlEnterHint: string;
  runButton: string;
  queryError: string;
  noResult: string;
  rowCountTemplate: string;
  postgresQueryPlaceholder: string;
  mongodbQueryPlaceholder: string;
}

export const projectDatabaseEn: ProjectDatabaseDict = {
  typeLabelPostgres: "PostgreSQL",
  typeLabelRedis: "Redis",
  typeLabelMongodb: "MongoDB",
  typeLabelCustom: "External / Custom",
  disabledTitle: "Database disabled for this project",
  disabledSubtitle: "Turn it back on in the Settings tab.",
  emptyState: "No database provisioned for this project yet.",
  provisionError: "Failed to provision the database.",
  unknownError: "Unknown error",
  postgresDescription: "Relational database, with a persistent volume and daily backup.",
  redisDescription: "In-memory cache/queue, by default doesn't survive a restart or get backed up.",
  mongodbDescription: "Document database, with a persistent volume and daily backup.",
  redisPersistentLabel:
    "This Redis holds important data (not sure? check it to be safe): persist to disk and include in the daily backup. Makes writes a bit slower.",
  provisionButtonTemplate: "Provision {type}",
  customDescription:
    "Already using something else (MongoDB Atlas, Supabase, your own Postgres, etc.)? Paste the connection string here. Korrelo doesn't spin up any container, it just injects it as an environment variable.",
  connectExternalButton: "Connect external database",
  envVarNameLabel: "Environment variable name",
  envVarNamePlaceholder: "DATABASE_URL",
  connectionStringLabel: "Connection string",
  connectionStringPlaceholder: "mongodb+srv://user:password@cluster.mongodb.net/mydb",
  connectButton: "Connect",
  showPassword: "Show password",
  hidePassword: "Hide password",
  envVarLabel: "Environment variable",
  hostLabel: "Host (inside the project's network)",
  portLabel: "Port",
  usernameLabel: "Username",
  databaseNameLabel: "Database",
  passwordLabel: "Password",
  persistenceLabel: "Persistence / backup",
  persistenceEnabled: "Enabled, included in the daily backup",
  persistenceDisabled: "Disabled, disposable cache",
  externalInfoPrefix: "External database. Korrelo doesn't spin up a container for it, it just injects",
  externalInfoSuffix: "as an environment variable.",
  configuredInfoPrefix: "Already set as an environment variable (",
  configuredInfoMiddle: "). Run",
  configuredInfoSuffix: "in the Summary tab to bring up the database container.",
  removeDatabaseButton: "Remove database",
  remove: "Remove",
  confirmRemoveTitle: "Remove the database?",
  confirmRemoveCustomBody: "The environment variable stays saved, but stops being managed here.",
  confirmRemoveBody: "The data is lost on the next deploy. This can't be undone.",
  listTablesError: "Failed to list tables.",
  entityLabelCollections: "Collections",
  entityLabelKeysSample: "Keys (sample)",
  entityLabelTables: "Tables",
  browserTitle: "Data browser",
  noneFoundYet: "None found yet.",
  ctrlEnterHint: "Ctrl/Cmd + Enter to run",
  runButton: "Run",
  queryError: "Failed to run the query.",
  noResult: "No result.",
  rowCountTemplate: "{count} row(s)",
  postgresQueryPlaceholder: "SELECT * FROM my_table LIMIT 100;",
  mongodbQueryPlaceholder: "db.myCollection.find().limit(20).toArray()",
};

export const projectDatabasePt: ProjectDatabaseDict = {
  typeLabelPostgres: "PostgreSQL",
  typeLabelRedis: "Redis",
  typeLabelMongodb: "MongoDB",
  typeLabelCustom: "Externo / Custom",
  disabledTitle: "Banco de dados desativado para este projeto",
  disabledSubtitle: "Ative de novo na aba Configurações.",
  emptyState: "Nenhum banco de dados provisionado pra este projeto ainda.",
  provisionError: "Falha ao provisionar o banco.",
  unknownError: "Erro desconhecido",
  postgresDescription: "Banco relacional, com volume persistente e no backup diário.",
  redisDescription: "Cache/fila em memória, por padrão não sobrevive a reinício nem entra no backup.",
  mongodbDescription: "Banco de documentos, com volume persistente e no backup diário.",
  redisPersistentLabel:
    "Este Redis guarda dado importante (não sei ao certo? marque por segurança): persistir em disco e incluir no backup diário. Deixa a escrita um pouco mais lenta.",
  provisionButtonTemplate: "Provisionar {type}",
  customDescription:
    "Já usa outra coisa (MongoDB Atlas, Supabase, um Postgres seu, etc.)? Cole a connection string aqui. O Korrelo não sobe container nenhum, só injeta como variável de ambiente.",
  connectExternalButton: "Conectar banco externo",
  envVarNameLabel: "Nome da variável de ambiente",
  envVarNamePlaceholder: "DATABASE_URL",
  connectionStringLabel: "Connection string",
  connectionStringPlaceholder: "mongodb+srv://usuario:senha@cluster.mongodb.net/meubanco",
  connectButton: "Conectar",
  showPassword: "Mostrar senha",
  hidePassword: "Ocultar senha",
  envVarLabel: "Variável de ambiente",
  hostLabel: "Host (dentro da rede do projeto)",
  portLabel: "Porta",
  usernameLabel: "Usuário",
  databaseNameLabel: "Banco",
  passwordLabel: "Senha",
  persistenceLabel: "Persistência / backup",
  persistenceEnabled: "Ativada, incluído no backup diário",
  persistenceDisabled: "Desativada, cache descartável",
  externalInfoPrefix: "Banco externo. O Korrelo não sobe container pra ele, só injeta",
  externalInfoSuffix: "como variável de ambiente.",
  configuredInfoPrefix: "Já configurado como variável de ambiente (",
  configuredInfoMiddle: "). Rode",
  configuredInfoSuffix: "na aba Resumo pra subir o container do banco.",
  removeDatabaseButton: "Remover banco de dados",
  remove: "Remover",
  confirmRemoveTitle: "Remover o banco de dados?",
  confirmRemoveCustomBody: "A variável de ambiente continua salva, mas deixa de ser gerenciada aqui.",
  confirmRemoveBody: "Os dados são perdidos no próximo deploy. Não pode ser desfeito.",
  listTablesError: "Falha ao listar tabelas.",
  entityLabelCollections: "Coleções",
  entityLabelKeysSample: "Chaves (amostra)",
  entityLabelTables: "Tabelas",
  browserTitle: "Navegador de dados",
  noneFoundYet: "Nenhuma encontrada ainda.",
  ctrlEnterHint: "Ctrl/Cmd + Enter pra executar",
  runButton: "Executar",
  queryError: "Falha ao executar a query.",
  noResult: "Sem resultado.",
  rowCountTemplate: "{count} linha(s)",
  postgresQueryPlaceholder: "SELECT * FROM minha_tabela LIMIT 100;",
  mongodbQueryPlaceholder: "db.minhaColecao.find().limit(20).toArray()",
};
