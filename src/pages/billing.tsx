"use client";

import * as React from "react";
import { apiFetch, apiWrite } from "@neton/application-client-runtime/client";
import { formatDateTime } from "@neton/application-client-runtime/types";
import {
  Alert, Button, Card, CardContent, CardHeader, CardTitle,
  DataTable, Field, Input, PageHeader, Pagination, type DataColumn,
} from "@neton/application-client-kit";

interface Balance { balance: number; reserved: number; available: number }
interface QuotaTransaction {
  id: number; type: string; amount: number; balanceAfter: number;
  ref?: string | null; createdAt?: number | null;
}
interface RedeemResult { balance: number; quotaMicro: number }
interface PageResp<T> { list: T[]; total: number; page: number; size: number; totalPages: number }

/**
 * 台账 type → 用户看得懂的词。
 *
 * 只列后端**真实在写**的六种（出处见 QuotaTransaction 的类级 KDoc）。未知类型原样显示、不猜：
 * 把没见过的串硬套一个中文词，会让「后端新增了一种入账」这件事在界面上彻底看不出来，
 * 而显示成裸英文串至少是个响的信号。后端预留的 `refund` 至今无产出点，所以这里也不列 ——
 * 哪天真开始写退款台账，界面会先显示 "refund" 提醒有人来补这一行。
 *
 * `grant` 标成「发放」而不是原先的「充值」是一次修正：grant 既包含运营手工补的额度，也包含
 * 下面那个模拟充值入口，而真实付款入账走的是 `recharge`。原先一律标「充值」，于是运营手工
 * 补的一笔钱在用户眼里成了「我充值过」—— 对账时两边说的根本不是同一件事。
 */
const TX_LABEL: Record<string, string> = {
  grant: "发放",
  recharge: "充值",
  redeem: "兑换码",
  invite: "邀请奖励",
  consume: "消费",
  revoke: "平台撤回",
};

/** 额度 μUSD（1e-6 USD）转成美元展示，避免用户对着 7 位整数猜。 */
function usd(micro: number): string {
  return `${micro < 0 ? "-" : ""}$${Math.abs(micro / 1_000_000).toFixed(4)}`;
}

/**
 * 充值、兑换与流水。
 *
 * 真实付款的下单流程还没有界面（后端 POST /app/gateway/recharge 已就绪，但支付渠道没有默认值、
 * 需要按返回的 displayMode/payload 把用户送去付款），所以这里目前只有兑换码与模拟充值两个入口。
 * 模拟充值需服务端显式开启 NEWGATE_ENABLE_MOCK_RECHARGE，用于联调「付款 → 额度到账 → 能用」。
 */
export default function Page() {
  const [balance, setBalance] = React.useState<Balance | null>(null);
  const [rows, setRows] = React.useState<QuotaTransaction[]>([]);
  const [total, setTotal] = React.useState(0);
  const [page, setPage] = React.useState(1);
  const [amount, setAmount] = React.useState("");
  const [code, setCode] = React.useState("");
  const [redeemed, setRedeemed] = React.useState<RedeemResult | null>(null);
  const [busy, setBusy] = React.useState(false);
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

  /**
   * 兑换。busy 期间按钮与输入框都禁用，这不只是观感问题：一张码只能兑一次，
   * 双击发出的第二发会在后端拿到 409「兑换码已被使用」—— 用户明明只点了一次，
   * 却被告知码被别人用了，那看起来像码被偷了。挡在前端比解释在后端便宜。
   *
   * 失败原因由后端直接给人话（兑换码无效 / 已被使用 / 已作废 / 已过期），原样透传即可。
   * 后端**刻意不在失败响应里带面额**（否则枚举命中的收益会从「知道这个码存在」升级成
   * 「知道它值多少钱」），所以这里也别试图在错误提示里补出金额。
   */
  async function redeem() {
    setError(null); setRedeemed(null); setBusy(true);
    try {
      const r = await apiWrite<RedeemResult>("/app/gateway/redeem", "POST", { code });
      setRedeemed(r); setCode(""); void load();
    } catch (cause) { setError((cause as Error).message); } finally { setBusy(false); }
  }

  const columns: DataColumn<QuotaTransaction>[] = [
    { key: "type", header: "类型", cell: (r) => TX_LABEL[r.type] ?? r.type },
    { key: "amount", header: "变动", cell: (r) => usd(r.amount) },
    { key: "balanceAfter", header: "变动后余额", cell: (r) => usd(r.balanceAfter) },
    { key: "ref", header: "凭据", cell: (r) => r.ref ?? "—" },
    { key: "createdAt", header: "时间", cell: (r) => formatDateTime(r.createdAt) },
  ];

  const negative = balance !== null && balance.available < 0;

  return (
    <div>
      <PageHeader eyebrow="BILLING" title="充值与流水" description="账户额度的兑换、充值记录与消费明细。" />
      {/* role="alert" 留给下面这条请求失败：无障碍语义里它是「需要立即注意」的通告，屏幕阅读器会
          打断用户。欠费说明是状态而非事故，用 Alert 组件（无 role）呈现，不该打断正在读流水的人。 */}
      {error ? <p role="alert">{error}</p> : null}

      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0,1fr))", gap: 12, margin: "12px 0" }}>
        <Card>
          <CardHeader><CardTitle>可用余额</CardTitle></CardHeader>
          <CardContent>{balance ? usd(balance.available) : "—"}</CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle>账面余额</CardTitle></CardHeader>
          <CardContent>{balance ? usd(balance.balance) : "—"}</CardContent>
        </Card>
        <Card>
          {/* 预留是进行中请求的资金占位，请求结束后按实际用量结算并退还差额 */}
          <CardHeader><CardTitle>进行中占用</CardTitle></CardHeader>
          <CardContent>{balance ? usd(balance.reserved) : "—"}</CardContent>
        </Card>
      </div>

      {negative ? (
        <Alert tone="warning" style={{ marginBottom: 12 }}>
          可用余额为负（{balance ? usd(balance.available) : "—"}）。这不是显示错误：账户已经欠费，
          新的 API 请求会被网关直接拒掉（402 insufficient_quota）。成因看下面的流水 ——
          标着「平台撤回」的行是运营收回了此前发放的额度，标着「消费」的行是按实际用量结算扣的费。
          兑换码或充值入账会先填平这个缺口，超出部分才可用；已经发出的请求不受影响。
        </Alert>
      ) : null}

      <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0,1fr))", gap: 12, margin: "12px 0" }}>
        <Card>
          <CardHeader><CardTitle>兑换码</CardTitle></CardHeader>
          <CardContent>
            <Field label="兑换码">
              <Input
                value={code}
                onChange={(e) => setCode(e.target.value)}
                placeholder="例如 7QK4X-9MZ2P-…"
                disabled={busy}
              />
            </Field>
            <p style={{ margin: "6px 0 0", fontSize: 12, color: "var(--muted-foreground)" }}>
              大小写、空格与连字符都不用管，服务端会归一化后比对。一张码只能兑一次，成功后额度立即到账。
            </p>
            <div style={{ marginTop: 8 }}>
              <Button onClick={() => void redeem()} disabled={busy || code.trim() === ""}>
                {busy ? "兑换中…" : "兑换"}
              </Button>
            </div>
            {redeemed ? (
              <p style={{ margin: "8px 0 0", fontSize: 13 }}>
                已入账 {usd(redeemed.quotaMicro)}，当前余额 {usd(redeemed.balance)}。
              </p>
            ) : null}
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle>模拟充值（测试环境）</CardTitle></CardHeader>
          <CardContent>
            <Field label="额度 μUSD">
              <Input value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="1000000 = $1" />
            </Field>
            <p style={{ margin: "6px 0 0", fontSize: 12, color: "var(--muted-foreground)" }}>
              需服务端开启 NEWGATE_ENABLE_MOCK_RECHARGE，正式环境不会开放。
              这条入账在下面的流水里记为「发放」，与真实付款的「充值」分开。
            </p>
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
