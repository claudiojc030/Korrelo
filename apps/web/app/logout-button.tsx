"use client";

import { useRouter } from "next/navigation";
import { clearTokenClient } from "../lib/auth-cookie-client";

export function LogoutButton() {
  const router = useRouter();

  function handleLogout() {
    clearTokenClient();
    router.push("/login");
    router.refresh();
  }

  return (
    <button onClick={handleLogout} className="text-sm text-neutral-500 underline hover:text-neutral-300">
      Sair
    </button>
  );
}
