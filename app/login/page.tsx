import type { Metadata } from "next";
import { LoginForm } from "@/components/claude/LoginForm";

export const metadata: Metadata = { title: "Sign in · agent-u" };

export default function LoginPage() {
  return (
    <main className="flex min-h-[100dvh] flex-col items-center justify-center bg-page px-[max(1rem,env(safe-area-inset-left))] pt-[max(1.5rem,env(safe-area-inset-top))] pb-[max(1.5rem,env(safe-area-inset-bottom))]">
      {/* sits a little above center, where the eye lands, and clears the phone keyboard */}
      <div className="flex w-full justify-center sm:-mt-[6vh]">
        <LoginForm />
      </div>
    </main>
  );
}
