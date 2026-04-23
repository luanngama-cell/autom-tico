import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Loader2, Plus } from "lucide-react";
import { BiDestinationsPanel } from "@/components/BiDestinationsPanel";

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
  return (
    <div className="p-8">
      <div>
        <h2 className="text-3xl font-bold tracking-tight">APIs customizadas</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Endpoints REST e destinos BI para sistemas externos.
        </p>
      </div>

      <Tabs defaultValue="bi" className="mt-6">
        <TabsList>
          <TabsTrigger value="bi">Destinos BI</TabsTrigger>
          <TabsTrigger value="custom">APIs sob medida</TabsTrigger>
        </TabsList>

        <TabsContent value="bi" className="mt-6">
          <BiDestinationsPanel />
        </TabsContent>

        <TabsContent value="custom" className="mt-6">
          <CustomApisList />
        </TabsContent>
      </Tabs>
    </div>
  );
}

function CustomApisList() {
  const [rows, setRows] = useState<Api[]>([]);
  const [loading, setLoading] = useState(true);

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

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          Endpoints REST construídos sobre as tabelas sincronizadas.
        </p>
        <Button disabled>
          <Plus className="mr-2 h-4 w-4" />
          Nova API (em breve)
        </Button>
      </div>

      <div className="rounded-lg border bg-card">
        {loading ? (
          <div className="flex items-center justify-center py-16">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : rows.length === 0 ? (
          <div className="py-16 text-center text-sm text-muted-foreground">
            Nenhuma API criada.
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Nome</TableHead>
                <TableHead>Método</TableHead>
                <TableHead>Rota</TableHead>
                <TableHead>Visibilidade</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((a) => (
                <TableRow key={a.id}>
                  <TableCell className="font-medium">{a.name}</TableCell>
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
                    <Badge variant={a.status === "published" ? "default" : "secondary"}>
                      {a.status}
                    </Badge>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </div>
    </div>
  );
}
