"use client";

import { useEffect, useState, type ReactNode } from "react";
import { OpenNewWindow } from "iconoir-react";
import { Card, Row } from "./controls";

const VERSION = process.env.NEXT_PUBLIC_APP_VERSION || "";
const COMMIT = process.env.NEXT_PUBLIC_BUILD_COMMIT || "";
const REPO = process.env.NEXT_PUBLIC_REPO_URL || "";

function Value({ children }: { children: ReactNode }) {
  return <span className="font-mono text-[12.5px] text-ink-2 select-all">{children}</span>;
}

function Link({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noreferrer" className="tap relative inline-flex h-8 items-center gap-1.5 rounded-control px-3 text-[12.5px] font-medium text-ink shadow-btn hover:bg-hover">
      {children}
      <OpenNewWindow width={13} height={13} strokeWidth={1.9} aria-hidden />
    </a>
  );
}

export function AboutSection() {
  const [host, setHost] = useState("");
  useEffect(() => setHost(window.location.host), []);
  return (
    <>
      <Card>
        <Row label="Version">
          <Value>{VERSION || "unknown"}</Value>
        </Row>
        {COMMIT && (
          <Row label="Build">
            {REPO ? (
              <a href={`${REPO}/commit/${COMMIT}`} target="_blank" rel="noreferrer" className="font-mono text-[12.5px] text-accent-ink hover:underline">
                {COMMIT}
              </a>
            ) : (
              <Value>{COMMIT}</Value>
            )}
          </Row>
        )}
        <Row label="Server" note="The address this browser uses to reach agent-u.">
          <Value>{host || "…"}</Value>
        </Row>
      </Card>
      {REPO && (
        <Card title="Links">
          <Row label="Source code" note="Read the code, setup guide and changes.">
            <Link href={REPO}>GitHub</Link>
          </Row>
          <Row label="Report a problem">
            <Link href={`${REPO}/issues/new`}>New issue</Link>
          </Row>
        </Card>
      )}
    </>
  );
}
