// ============================================================
// SyncTab — PLACEHOLDER (UI pass U1)
//
// App.jsx shows the Sync rail tab only while Device Sync is on, and renders
// this. Phase U2 of sync-temp/plans/device-sync-ui-pass.md replaces it with
// the real tab (target bar, ledger, review, progress). Until then it only
// points at Settings → Sync, where targets are already editable.
// ============================================================

import React from "react";
import { FolderSync } from "lucide-react";
import { Button } from "@/components/ui/primitives";

export default function SyncTab({ sync, onOpenSettings }) {
  const targets = (sync.config && sync.config.targets) || [];
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
      <FolderSync className="h-8 w-8 text-muted-foreground" />
      <div className="text-sm font-medium">The Sync tab isn't built yet</div>
      <div className="max-w-sm text-xs text-muted-foreground">
        {targets.length
          ? `${targets.length} sync target${targets.length === 1 ? "" : "s"} set up. Review and syncing arrive in the next update.`
          : "Add a tablet or a folder in Settings → Sync."}
      </div>
      <Button size="sm" variant="outline" onClick={onOpenSettings}>
        Open Settings → Sync
      </Button>
    </div>
  );
}
