export interface ProjectFilesDict {
  loading: string;
  noFiles: string;
  selectFilePlaceholder: string;
  chooseFilePrompt: string;
  save: string;
  openFileError: string;
  saveError: string;
  unknownError: string;
}

export const projectFilesEn: ProjectFilesDict = {
  loading: "Loading...",
  noFiles: "No files (project not imported yet?).",
  selectFilePlaceholder: "Select a file",
  chooseFilePrompt: "Choose a file on the left to view and edit it.",
  save: "Save",
  openFileError: "Couldn't open the file.",
  saveError: "Couldn't save.",
  unknownError: "Unknown error",
};

export const projectFilesPt: ProjectFilesDict = {
  loading: "Carregando...",
  noFiles: "Sem arquivos (projeto ainda não importado?).",
  selectFilePlaceholder: "Selecione um arquivo",
  chooseFilePrompt: "Escolha um arquivo à esquerda pra ver e editar.",
  save: "Salvar",
  openFileError: "Falha ao abrir o arquivo.",
  saveError: "Falha ao salvar.",
  unknownError: "Erro desconhecido",
};
