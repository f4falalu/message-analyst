import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  appOrigin,
  runConnectionCheck,
  type ConnectionReport,
  type HopStatus,
} from "@/lib/connection-check";

const ORIGINS_KEY = "ollama-origins";

const STATUS_TONE: Record<HopStatus, string> = {
  ok: "text-emerald-600 dark:text-emerald-400",
  blocked: "text-amber-600 dark:text-amber-400",
  unreachable: "text-destructive",
};

const STATUS_LABEL: Record<HopStatus, string> = {
  ok: "pass",
  blocked: "blocked",
  unreachable: "no answer",
};

type Platform = "macos" | "linux" | "windows";

const PLATFORM_LABEL: Record<Platform, string> = {
  macos: "macOS",
  linux: "Linux",
  windows: "Windows",
};

function detectPlatform(): Platform {
  if (typeof navigator === "undefined") return "macos";
  const ua = navigator.userAgent;
  if (/Win/i.test(ua)) return "windows";
  if (/Mac/i.test(ua)) return "macos";
  return "linux";
}

/** The exact commands to set the origin allowance and restart Ollama. */
function restartSteps(platform: Platform, origins: string): string[] {
  if (platform === "windows") {
    return [
      `setx OLLAMA_ORIGINS "${origins}"`,
      `setx OLLAMA_HOST "0.0.0.0:11434"`,
      "Quit Ollama from the system tray, then start it again",
      "ngrok http 11434 --host-header=localhost:11434",
    ];
  }
  if (platform === "macos") {
    return [
      `launchctl setenv OLLAMA_ORIGINS "${origins}"`,
      `launchctl setenv OLLAMA_HOST "0.0.0.0:11434"`,
      "Quit Ollama from the menu bar, then open it again",
      "ngrok http 11434 --host-header=localhost:11434",
    ];
  }
  return [
    "systemctl edit --force ollama    # or stop the running ollama serve",
    `Environment="OLLAMA_ORIGINS=${origins}"`,
    `Environment="OLLAMA_HOST=0.0.0.0:11434"`,
    "systemctl daemon-reload && systemctl restart ollama",
    "ngrok http 11434 --host-header=localhost:11434",
  ];
}

async function copy(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    toast.success("Copied.");
  } catch {
    toast.error("Copying was blocked — select the text and copy it manually.");
  }
}

/**
 * Connection panel for a model on the user's own machine: tests both hops of
 * the path a run actually takes, and holds the OLLAMA_ORIGINS value the user
 * needs to paste on that machine.
 */
export function LocalConnectionPanel({ baseUrl }: { baseUrl: string }) {
  const [report, setReport] = useState<ConnectionReport | null>(null);
  const [checking, setChecking] = useState(false);
  const [origins, setOrigins] = useState("*");
  const [platform, setPlatform] = useState<Platform>("macos");

  useEffect(() => {
    setPlatform(detectPlatform());
    const stored = typeof window === "undefined" ? null : window.localStorage.getItem(ORIGINS_KEY);
    if (stored) setOrigins(stored);
  }, []);

  const saveOrigins = (value: string) => {
    setOrigins(value);
    if (typeof window !== "undefined") window.localStorage.setItem(ORIGINS_KEY, value);
  };

  const run = async () => {
    if (!baseUrl) return;
    setChecking(true);
    try {
      const result = await runConnectionCheck(baseUrl);
      setReport(result);
      if (result.ok) toast.success(result.summary);
      else toast.error(result.summary);
    } finally {
      setChecking(false);
    }
  };

  const steps = restartSteps(platform, origins || "*");

  return (
    <div className="space-y-4 rounded-md border border-border/60 p-4 md:col-span-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="text-sm font-medium text-foreground">Check connection</p>
          <p className="text-xs text-muted-foreground">
            Tests both hops separately: this browser to the tunnel, and the tunnel to Ollama.
          </p>
        </div>
        <Button type="button" size="sm" disabled={checking || !baseUrl} onClick={() => void run()}>
          {checking ? "Checking…" : "Run check"}
        </Button>
      </div>

      {report ? (
        <div className="space-y-2">
          <p className={`text-xs ${report.ok ? "text-muted-foreground" : "text-destructive"}`}>{report.summary}</p>
          {report.hops.map((hop) => (
            <div key={hop.id} className="rounded border border-border/60 p-2.5">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs font-medium text-foreground">{hop.label}</span>
                <Badge variant="outline" className={STATUS_TONE[hop.status]}>
                  {hop.httpStatus ? `${hop.httpStatus} · ` : ""}
                  {STATUS_LABEL[hop.status]}
                </Badge>
              </div>
              <p className="mt-1 text-xs text-muted-foreground">{hop.detail}</p>
              {hop.hint ? <p className="mt-1 text-xs text-amber-600 dark:text-amber-400">{hop.hint}</p> : null}
            </div>
          ))}
          <p className="text-[11px] text-muted-foreground">
            Checked {new Date(report.ranAt).toLocaleTimeString()} · this page&apos;s origin is{" "}
            <code className="font-mono">{report.origin || "unknown"}</code>
          </p>
        </div>
      ) : null}

      <div className="space-y-2 border-t border-border/60 pt-3">
        <Label className="text-xs">OLLAMA_ORIGINS value</Label>
        <div className="flex flex-wrap gap-2">
          <Input
            className="max-w-md font-mono text-xs"
            value={origins}
            onChange={(event) => saveOrigins(event.target.value)}
            placeholder="*"
          />
          <Button type="button" size="sm" variant="outline" onClick={() => saveOrigins("*")}>
            Use *
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={!appOrigin()}
            onClick={() => saveOrigins(appOrigin())}
          >
            Use this app&apos;s address
          </Button>
          <Button type="button" size="sm" variant="ghost" onClick={() => void copy(origins || "*")}>
            Copy value
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          Ollama only answers pages whose address is listed here. This app remembers the value for you, but it must
          be set as an environment variable on the computer running Ollama.
        </p>
      </div>

      <div className="space-y-2 border-t border-border/60 pt-3">
        <div className="flex flex-wrap items-center gap-2">
          <Label className="text-xs">Restart instructions</Label>
          {(Object.keys(PLATFORM_LABEL) as Platform[]).map((key) => (
            <Button
              key={key}
              type="button"
              size="sm"
              variant={platform === key ? "secondary" : "ghost"}
              onClick={() => setPlatform(key)}
            >
              {PLATFORM_LABEL[key]}
            </Button>
          ))}
          <Button type="button" size="sm" variant="ghost" onClick={() => void copy(steps.join("\n"))}>
            Copy all
          </Button>
        </div>
        <ol className="list-decimal space-y-1 pl-5">
          {steps.map((step) => (
            <li key={step} className="font-mono text-xs text-muted-foreground">
              {step}
            </li>
          ))}
        </ol>
        <p className="text-xs text-muted-foreground">
          Ollama reads these variables only at start-up, so it must be fully quit and reopened — and the tunnel
          restarted after it. Then run the check again.
        </p>
      </div>
    </div>
  );
}
