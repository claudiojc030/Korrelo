import FilesClient from "./files-client";

export default async function FilesPage(props: { params: Promise<{ projectId: string }> }) {
  const params = await props.params;
  return <FilesClient projectId={params.projectId} />;
}
