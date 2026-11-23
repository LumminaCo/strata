import { useEffect, useState } from "react";

import { DatabaseIcon } from "@/components/database-icon";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { AuditEntry, Connection } from "@/ipc/bindings/protocol";
import { dispatch, errorMessage } from "@/ipc/client";

export function AgentActivity({
  profiles,
  onOpen,
  onClose,
}: {
  profiles: Connection[];
  onOpen: (id: string, database: string, sql: string) => void;
  onClose: () => void;
}) {
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [error, setError] = useState("");
  useEffect(() => {
    let current = true;
    let busy = false;
    async function load() {
      if (busy) return;
      busy = true;
      try {
        const audit = await dispatch("audit_list", {});
        if (current) {
          setEntries(audit);
          setError("");
        }
      } catch (error) {
        if (current) setError(errorMessage(error));
      } finally {
        busy = false;
      }
    }
    void load();
    const timer = setInterval(() => void load(), 2000);
    return () => {
      current = false;
      clearInterval(timer);
    };
  }, []);
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="activity-dialog">
        <DialogHeader>
          <DialogTitle>Agent activity</DialogTitle>
          <DialogDescription>Recent calls through the Strata MCP server.</DialogDescription>
        </DialogHeader>
        <div className="activity-list">
          {error && <p role="alert">{error}</p>}
          {!entries.length && !error && <p>No tool calls recorded.</p>}
          {entries.map((item) => {
            const profile = profiles.find((profile) => profile.name === item.connectionName);
            return (
              <article key={item.id}>
                <div className="activity-heading">
                  <strong>{item.tool}</strong>
                  <Badge variant="outline" data-decision={item.decision}>
                    {item.decision}
                  </Badge>
                  <small>{new Date(item.ts).toLocaleString()}</small>
                </div>
                <div className="activity-context">
                  {profile && <DatabaseIcon kind={profile.kind} />}
                  <span>
                    {item.clientName || "MCP client"} · {item.connectionName}
                    {item.rows === null ? "" : ` · ${item.rows} rows`}
                    {item.durationMs === null ? "" : ` · ${item.durationMs} ms`}
                  </span>
                </div>
                {item.sql && <pre>{item.sql}</pre>}
                {item.reason && <p>{item.reason}</p>}
                {profile?.id && item.sql && (
                  <Button
                    type="button"
                    size="xs"
                    variant="outline"
                    onClick={() => onOpen(profile.id!, profile.database, item.sql!)}
                  >
                    Open SQL
                  </Button>
                )}
              </article>
            );
          })}
        </div>
      </DialogContent>
    </Dialog>
  );
}
