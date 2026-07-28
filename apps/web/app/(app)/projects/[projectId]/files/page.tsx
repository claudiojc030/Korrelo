import FilesClient from "./files-client";

export default function FilesPage({ params }: { params: { projectId: string } }) {
  return <FilesClient projectId={params.projectId} />;
}
