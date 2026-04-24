import { createFileRoute } from "@tanstack/react-router";
import { Fragment, useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Loader2, Plus, ChevronRight, Webhook } from "lucide-react";
import { BiDestinationsPanel } from "@/components/BiDestinationsPanel";
import { getBiSnapshotUrl } from "@/lib/public-base-url";

export const Route = createFileRoute("/dashboard/apis")({
  component: ApisPage,
});

type Api = {
  id: string;
  name: string;
  method: string;
  route: string;
  status: string;
  is_public: boolean;
  description: string | null;
};

function ApisPage() {
  const biSnapshotUrl = getBiSnapshotUrl(
    typeof window !== "undefined" ? window.location.origin : undefined
  );
  const [rows, setRows] = useState<Api[]>([]);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      const { data } = await supabase
        .from("custom_apis")
        .select("*")
        .order("created_at", { ascending: false });
      setRows((data as Api[]) ?? []);
      setLoading(false);
    })();
  }, []);

  const toggle = (key: string) => setExpanded((prev) => (prev === key ? null : key));

  return (
    <div className="p-8">
      <div>
        <h2 className="text-3xl font-bold tracking-tight">APIs customizadas</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Endpoints REST e destinos BI para sistemas externos.
        </p>
      </div>

      <div className="mt-6 space-y-4">
        <div className="flex items-center justify-between">
          <p className="text-sm text-muted-foreground">
            Clique numa linha para ver os detalhes.
          </p>
          <Button disabled>
            <Plus className="mr-2 h-4 w-4" />
            Nova API (em breve)
          </Button>
        </div>

        <div className="rounded-lg border bg-card overflow-hidden">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-8" />
                <TableHead>Nome</TableHead>
                <TableHead>Tipo</TableHead>
                <TableHead>Método</TableHead>
                <TableHead>Rota</TableHead>
                <TableHead>Visibilidade</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {/* Built-in BI destinations row */}
              <Fragment>
                <TableRow
                  className="cursor-pointer hover:bg-muted/50"
                  onClick={() => toggle("__bi__")}
                >
                  <TableCell>
                    <ChevronRight
                      className={`h-4 w-4 text-muted-foreground transition-transform ${expanded === "__bi__" ? "rotate-90" : ""}`}
                    />
                  </TableCell>
                  <TableCell className="font-medium">
                    <div className="flex items-center gap-2">
                      <Webhook className="h-4 w-4 text-muted-foreground" />
                      Destinos BI
                    </div>
                  </TableCell>
                  <TableCell>
                    <Badge variant="secondary">Integrada</Badge>
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline">GET</Badge>
                  </TableCell>
                  <TableCell className="font-mono text-[11px] leading-relaxed break-all">
                    {biSnapshotUrl}
                  </TableCell>
                  <TableCell>
                    <Badge>Pública</Badge>
                  </TableCell>
                  <TableCell>
                    <Badge>ativo</Badge>
                  </TableCell>
                </TableRow>
                {expanded === "__bi__" && (
                  <TableRow className="hover:bg-transparent">
                    <TableCell colSpan={7} className="bg-muted/20 p-6">
                      <BiDestinationsPanel />
                    </TableCell>
                  </TableRow>
                )}
              </Fragment>

              {/* Custom APIs */}
              {loading ? (
                <TableRow>
                  <TableCell colSpan={7}>
                    <div className="flex items-center justify-center py-8">
                      <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                    </div>
                  </TableCell>
                </TableRow>
              ) : rows.length === 0 ? (
                <TableRow>
                  <TableCell
                    colSpan={7}
                    className="py-8 text-center text-sm text-muted-foreground"
                  >
                    Nenhuma API customizada criada.
                  </TableCell>
                </TableRow>
              ) : (
                rows.map((a) => (
                  <Fragment key={a.id}>
                    <TableRow
                      className="cursor-pointer hover:bg-muted/50"
                      onClick={() => toggle(a.id)}
                    >
                      <TableCell>
                        <ChevronRight
                          className={`h-4 w-4 text-muted-foreground transition-transform ${expanded === a.id ? "rotate-90" : ""}`}
                        />
                      </TableCell>
                      <TableCell className="font-medium">{a.name}</TableCell>
                      <TableCell>
                        <Badge variant="outline">Custom</Badge>
                      </TableCell>
                      <TableCell>
                        <Badge variant="outline">{a.method}</Badge>
                      </TableCell>
                      <TableCell className="font-mono text-xs">{a.route}</TableCell>
                      <TableCell>
                        <Badge variant={a.is_public ? "default" : "secondary"}>
                          {a.is_public ? "Pública" : "Privada"}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        <Badge
                          variant={a.status === "published" ? "default" : "secondary"}
                        >
                          {a.status}
                        </Badge>
                      </TableCell>
                    </TableRow>
                    {expanded === a.id && (
                      <TableRow className="hover:bg-transparent">
                        <TableCell colSpan={7} className="bg-muted/20 p-6">
                          <div className="space-y-2 text-sm">
                            {a.description && (
                              <p className="text-muted-foreground">{a.description}</p>
                            )}
                            <div>
                              <span className="font-medium">Rota:</span>{" "}
                              <code className="font-mono text-xs">{a.route}</code>
                            </div>
                          </div>
                        </TableCell>
                      </TableRow>
                    )}
                  </Fragment>
                ))
              )}
            </TableBody>
          </Table>
        </div>
      </div>
    </div>
  );
}
