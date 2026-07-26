"use client";

import * as React from "react";
import { apiFetch, apiWrite } from "@neton/application-client-runtime/client";
import {
  Button, Card, CardContent, CardHeader, CardTitle,
  DataTable, Field, Input, PageHeader, Pagination, type DataColumn,
} from "@neton/application-client-kit";

interface Balance { balance: number; reserved: number; available: number }
interface QuotaTransaction {
  id: number; type: string; amount: number; balanceAfter: number;
  ref?: string | null; createdAt?: number | null;
}
interface PageResp<T> { list: T[]; total: number; page: number; size: number; totalPages: number }

function usd(micro: number): string {
  return `${micro < 0 ? "-" : ""}$${Math.abs(micro / 1_000_000).toFixed(4)}`;
}

/**
 * 充值与流水。
 *
 * 当前只有模拟充值（服务端需显式开启 NEWGATE_ENABLE_MOCK_RECHARGE），用于联调
 * 「付款 → 额度到账 → 能用」这条链路；接入真实支付后此处换成下单流程。
 */
export default function Page() {
  const [balance, setBalance] = React.useState<Balance | null>(null);
  const [rows, setRows] = React.useState<QuotaTransaction[]>([]);
  const [total, setTotal] = React.useState(0);
  const [page, setPage] = React.useState(1);
  const [amount, setAmount] = React.useState("");
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const size = 20;

  const load = React.useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const [b, p] = await Promise.all([
        apiFetch<Balance>("/app/gateway/usage/balance"),
        apiFetch<PageResp<QuotaTransaction>>(`/app/gateway/usage/transaction/page?pageNo=${page}&pageSize=${size}`),
      ]);
      setBalance(b); setRows(p.list); setTotal(p.total);
    } catch (cause) { setError((cause as Error).message); } finally { setLoading(false); }
  }, [page]);

  React.useEffect(() => { void load(); }, [load]);

  async function recharge() {
    setError(null);
    try {
      await apiWrite("/app/gateway/recharge/mock", "POST", { amount: Number(amount) });
      setAmount(""); void load();
    } catch (cause) { setError((cause as Error).message); }
  }

  const columns: DataColumn<QuotaTransaction>[] = [
    { key: "type", header: "类型", cell: (r) => (r.type === "grant" ? "充值" : r.type === "consume" ? "消费" : r.type) },
    { key: "amount", header: "变动", cell: (r) => usd(r.amount) },
    { key: "balanceAfter", header: "变动后余额", cell: (r) => usd(r.balanceAfter) },
    { key: "ref", header: "凭据", cell: (r) => r.ref ?? "—" },
  ];

  return (
    <div>
      <PageHeader eyebrow="BILLING" title="充值与流水" description="账户额度的充值记录与消费明细。" />
      {error ? <p role="alert">{error}</p> : null}

      <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0,1fr))", gap: 12, margin: "12px 0" }}>
        <Card>
          <CardHeader><CardTitle>可用余额</CardTitle></CardHeader>
          <CardContent>{balance ? usd(balance.available) : "—"}</CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle>模拟充值（测试环境）</CardTitle></CardHeader>
          <CardContent>
            <Field label="额度 μUSD">
              <Input value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="1000000 = $1" />
            </Field>
            <div style={{ marginTop: 8 }}><Button onClick={() => void recharge()}>充值</Button></div>
          </CardContent>
        </Card>
      </div>

      <DataTable columns={columns} rows={rows} loading={loading} rowKey={(r) => r.id} />
      <Pagination
        page={page}
        pageSize={size}
        total={total}
        loading={loading}
        onPageChange={setPage}
        onPageSizeChange={() => { /* 固定每页条数，暂不开放调整 */ }}
      />
    </div>
  );
}
