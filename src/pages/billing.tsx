"use client";

import * as React from "react";
import { apiFetch, apiWrite } from "@neton/application-client-runtime/client";
import { useDescribeError } from "@neton/application-client-runtime/errors";
import { useT, type Translate } from "@neton/application-client-runtime/i18n";
import { useQuery, useQueryClient } from "@neton/application-client-runtime/client-context";
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

/** 后端 /app/pay/channel/list：运营启用的支付渠道，displayMode 决定怎么把用户送去付款。 */
interface PayChannel { code: string; method: string; displayMode: string; remark?: string | null }
interface RechargeOrder {
  rechargeId: number; merchantOrderId: string; amountMicro: number; price: number;
  orderId: number; displayMode: string; payload: string; channelOrderNo?: string | null;
}
interface RechargeStatus {
  rechargeId: number; merchantOrderId: string; amountMicro: number; price: number;
  payStatus: number; paidAt?: number | null; createdAt?: number | null;
}

/** 与后端 QuotaRechargeLogic.PAY_STATUS_* 一致。 */
const PAY_WAITING = 0, PAY_PAID = 1, PAY_CLOSED = 2;

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
const TX_TYPES = new Set(["grant", "recharge", "redeem", "invite", "consume", "revoke", "refund"]);

/** 支付方式 → 词条 billing.method.<key>；wxpay 与 wechat 同义。 */
const METHOD_KEY: Record<string, string> = {
  alipay: "alipay", wechat: "wechat", wxpay: "wechat", stripe: "stripe", sandbox: "sandbox",
};

function txLabel(type: string, t: Translate): string {
  return TX_TYPES.has(type) ? t(`billing.tx.${type}`) : type;
}

/** 额度 μUSD（1e-6 USD）转成美元展示，避免用户对着 7 位整数猜。 */
function usd(micro: number): string {
  return `${micro < 0 ? "-" : ""}$${Math.abs(micro / 1_000_000).toFixed(4)}`;
}

/** 法币最小单位（分）→ 元。price 与 payment 的 pay_orders.price 同单位。 */
function fiat(minor: number): string {
  return `¥${(minor / 100).toFixed(2)}`;
}

function channelLabel(c: PayChannel, t: Translate): string {
  const key = METHOD_KEY[c.method.toLowerCase()];
  const m = key ? t(`billing.method.${key}`) : c.method;
  return c.remark ? t("billing.channel_with_remark", { method: m, remark: c.remark }) : m;
}

/**
 * 充值、兑换与流水。
 *
 * 真实付款：选渠道 → 填金额 → POST /app/gateway/recharge 建单 → 按 displayMode 把用户送去付款
 * （跳转 / 二维码 / SDK 参数）→ 轮询 GET /app/gateway/recharge/get/{id} 直到 payStatus 变成已付，
 * 额度由回调入账，界面只负责刷新余额。到账额度按服务端汇率算（NETONAPI_QUOTA_PER_PRICE_UNIT），
 * 界面不承诺具体数字，只在建单后显示后端算出来的 amountMicro。
 *
 * 模拟充值保留给联调（需服务端显式开启 NETONAPI_ENABLE_MOCK_RECHARGE），放在真实入口下面、
 * 措辞标明是测试环境。
 */
export default function Page() {
  const describeError = useDescribeError("payment");
  const t = useT("payment");
  const [page, setPage] = React.useState(1);
  const [amount, setAmount] = React.useState("");
  const [code, setCode] = React.useState("");
  const [redeemed, setRedeemed] = React.useState<RedeemResult | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const size = 20;

  // ── 真实充值 ──
  const [channelCode, setChannelCode] = React.useState("");
  const [yuan, setYuan] = React.useState("");
  const [ordering, setOrdering] = React.useState(false);
  const [order, setOrder] = React.useState<RechargeOrder | null>(null);
  const [payState, setPayState] = React.useState<"idle" | "waiting" | "paid" | "closed" | "timeout">("idle");
  const [paidStatus, setPaidStatus] = React.useState<RechargeStatus | null>(null);

  // useQuery 而不是 effect 里取数：工作区切回页签会重挂 effect，那样每次切换都整页重拉、表格先清空。
  // 余额与「用量」页共用同一个 key，在这里充值/兑换后那边也跟着失效。
  const client = useQueryClient();
  const balanceQ = useQuery({ queryKey: ["gateway-balance"], queryFn: () => apiFetch<Balance>("/app/gateway/usage/balance") });
  const txQ = useQuery({
    queryKey: ["gateway-transactions", page],
    queryFn: () => apiFetch<PageResp<QuotaTransaction>>(`/app/gateway/usage/transaction/page?pageNo=${page}&pageSize=${size}`),
    placeholderData: (prev) => prev,
  });
  // 渠道拉不到按「没有可用渠道」处理，不挡流水与兑换
  const channelsQ = useQuery({ queryKey: ["pay-channels"], queryFn: () => apiFetch<PayChannel[]>("/app/pay/channel/list").catch(() => [] as PayChannel[]) });
  const balance = balanceQ.data ?? null;
  const rows = txQ.data?.list ?? [];
  const total = txQ.data?.total ?? 0;
  const loading = balanceQ.isLoading || txQ.isLoading;
  const channels = channelsQ.data ?? null;
  const loadError = balanceQ.error ?? txQ.error;
  const load = React.useCallback(() => {
    void client.invalidateQueries({ queryKey: ["gateway-balance"] });
    void client.invalidateQueries({ queryKey: ["gateway-transactions"] });
  }, [client]);

  React.useEffect(() => {
    if (channels && channels.length > 0) setChannelCode((c) => c || channels[0].code);
  }, [channels]);

  /**
   * 付款结果轮询。每 2 秒查一次，最多 10 分钟：支付宝/微信的二维码本身也差不多这个有效期。
   * 到期没付就停下来标「超时」，用户可以重新下单；已经付了但回调慢的情况，刷新页面重新
   * 进来流水里会看到那笔 recharge —— 钱不会丢，只是这个轮询不再替它等。
   */
  React.useEffect(() => {
    if (!order || payState !== "waiting") return;
    let alive = true;
    const startedAt = Date.now();
    const timer = window.setInterval(async () => {
      if (!alive) return;
      try {
        const st = await apiFetch<RechargeStatus>(`/app/gateway/recharge/get/${order.rechargeId}`);
        if (!alive) return;
        if (st.payStatus === PAY_PAID) { setPayState("paid"); setPaidStatus(st); void load(); }
        else if (st.payStatus === PAY_CLOSED) setPayState("closed");
        else if (Date.now() - startedAt > 10 * 60 * 1000) setPayState("timeout");
      } catch { /* 网络抖动：下一轮再试 */ }
    }, 2000);
    return () => { alive = false; window.clearInterval(timer); };
  }, [order, payState, load]);

  async function createOrder() {
    setError(null); setOrder(null); setPaidStatus(null);
    const price = Math.round(Number(yuan) * 100);
    if (!Number.isFinite(price) || price <= 0) { setError(t("billing.err.amount_invalid")); return; }
    if (!channelCode) { setError(t("billing.err.channel_required")); return; }
    setOrdering(true);
    try {
      const o = await apiWrite<RechargeOrder>("/app/gateway/recharge", "POST", { price, channelCode });
      setOrder(o); setPayState("waiting");
      // 跳转类渠道开新窗口付款，本页留着轮询结果；弹窗被拦时下面仍有手动链接兜底。
      if (o.displayMode === "REDIRECT_URL" && o.payload) window.open(o.payload, "_blank", "noopener");
    } catch (cause) { setError(describeError(cause)); } finally { setOrdering(false); }
  }

  async function recharge() {
    setError(null);
    try {
      await apiWrite("/app/gateway/recharge/mock", "POST", { amount: Number(amount) });
      setAmount(""); void load();
    } catch (cause) { setError(describeError(cause)); }
  }

  /**
   * 兑换。busy 期间按钮与输入框都禁用，这不只是观感问题：一张码只能兑一次，
   * 双击发出的第二发会在后端拿到 409「兑换码已被使用」—— 用户明明只点了一次，
   * 却被告知码被别人用了，那看起来像码被偷了。挡在前端比解释在后端便宜。
   *
   * 失败原因是后端的机器码（REDEMPTION_CODE_NOT_FOUND / _USED / _DISABLED / _EXPIRED），按语言包翻译。
   * 后端**刻意不在失败响应里带面额**（否则枚举命中的收益会从「知道这个码存在」升级成
   * 「知道它值多少钱」），所以这里也别试图在错误提示里补出金额。
   */
  async function redeem() {
    setError(null); setRedeemed(null); setBusy(true);
    try {
      const r = await apiWrite<RedeemResult>("/app/gateway/redeem", "POST", { code });
      setRedeemed(r); setCode(""); void load();
    } catch (cause) { setError(describeError(cause)); } finally { setBusy(false); }
  }

  const columns: DataColumn<QuotaTransaction>[] = [
    { key: "type", header: t("billing.col.type"), cell: (r) => txLabel(r.type, t) },
    { key: "amount", header: t("billing.col.amount"), cell: (r) => usd(r.amount) },
    { key: "balanceAfter", header: t("billing.col.balance_after"), cell: (r) => usd(r.balanceAfter) },
    { key: "ref", header: t("billing.col.ref"), cell: (r) => r.ref ?? "—" },
    { key: "createdAt", header: t("billing.col.time"), cell: (r) => formatDateTime(r.createdAt) },
  ];

  const negative = balance !== null && balance.available < 0;
  const muted: React.CSSProperties = { margin: "6px 0 0", fontSize: 12, color: "var(--muted-foreground)" };

  return (
    <div className="flex flex-col gap-4">
      <PageHeader eyebrow="BILLING" title={t("billing.title")} description={t("billing.description")} />
      {/* role="alert" 留给下面这条请求失败：无障碍语义里它是「需要立即注意」的通告，屏幕阅读器会
          打断用户。欠费说明是状态而非事故，用 Alert 组件（无 role）呈现，不该打断正在读流水的人。 */}
      {error ?? loadError ? <p role="alert">{error ?? describeError(loadError)}</p> : null}

      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0,1fr))", gap: 12 }}>
        <Card>
          <CardHeader><CardTitle>{t("billing.available")}</CardTitle></CardHeader>
          <CardContent>{balance ? usd(balance.available) : "—"}</CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle>{t("billing.balance")}</CardTitle></CardHeader>
          <CardContent>{balance ? usd(balance.balance) : "—"}</CardContent>
        </Card>
        <Card>
          {/* 预留是进行中请求的资金占位，请求结束后按实际用量结算并退还差额 */}
          <CardHeader><CardTitle>{t("billing.reserved")}</CardTitle></CardHeader>
          <CardContent>{balance ? usd(balance.reserved) : "—"}</CardContent>
        </Card>
      </div>

      {negative ? (
        <Alert tone="warning" style={{ marginBottom: 12 }}>
          {t("billing.negative_notice", { amount: balance ? usd(balance.available) : "—", revoke: t("billing.tx.revoke"), consume: t("billing.tx.consume") })}
        </Alert>
      ) : null}

      <Card>
        <CardHeader><CardTitle>{t("billing.online.title")}</CardTitle></CardHeader>
        <CardContent>
          {channels === null ? (
            <p style={muted}>{t("billing.online.loading")}</p>
          ) : channels.length === 0 ? (
            <p style={muted}>{t("billing.online.unavailable")}</p>
          ) : (
            <>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0,1fr))", gap: 12 }}>
                <Field label={t("billing.online.channel")}>
                  <select
                    value={channelCode}
                    onChange={(e) => setChannelCode(e.target.value)}
                    disabled={ordering || payState === "waiting"}
                    style={{ width: "100%", padding: "8px 10px", borderRadius: 6, border: "1px solid var(--border)", background: "transparent", color: "inherit" }}
                  >
                    {channels.map((c) => <option key={c.code} value={c.code}>{channelLabel(c, t)}</option>)}
                  </select>
                </Field>
                <Field label={t("billing.online.amount")}>
                  <Input
                    value={yuan}
                    onChange={(e) => setYuan(e.target.value)}
                    placeholder={t("billing.online.amount_placeholder")}
                    inputMode="decimal"
                    disabled={ordering || payState === "waiting"}
                  />
                </Field>
              </div>
              <p style={muted}>{t("billing.online.hint")}</p>
              <div style={{ marginTop: 8, display: "flex", gap: 8 }}>
                <Button onClick={() => void createOrder()} disabled={ordering || payState === "waiting" || yuan.trim() === ""}>
                  {ordering ? t("billing.online.ordering") : t("billing.online.pay")}
                </Button>
                {payState === "waiting" ? (
                  <Button variant="secondary" onClick={() => { setPayState("idle"); setOrder(null); }}>{t("billing.online.stop_waiting")}</Button>
                ) : null}
              </div>
            </>
          )}

          {order ? (
            <div style={{ marginTop: 12, padding: 12, borderRadius: 8, border: "1px solid var(--border)" }}>
              <p style={{ margin: 0, fontSize: 13 }}>
                {t("billing.order.summary", { id: order.merchantOrderId, price: fiat(order.price), amount: usd(order.amountMicro) })}
              </p>
              {payState === "waiting" ? (
                <>
                  {order.displayMode === "REDIRECT_URL" ? (
                    <p style={muted}>
                      {t("billing.order.redirect_before")}
                      <a href={order.payload} target="_blank" rel="noopener noreferrer">{t("billing.order.redirect_link")}</a>
                      {t("billing.order.redirect_after")}
                    </p>
                  ) : order.displayMode === "QR_CODE" ? (
                    <>
                      <p style={muted}>{t("billing.order.qr")}</p>
                      <QrBox text={order.payload} />
                    </>
                  ) : (
                    <>
                      <p style={muted}>{t("billing.order.sdk")}</p>
                      <pre style={{ fontSize: 12, overflowX: "auto", margin: 0 }}>{order.payload}</pre>
                    </>
                  )}
                  <p style={muted}>{t("billing.order.waiting")}</p>
                </>
              ) : payState === "paid" ? (
                <p style={{ margin: "6px 0 0", fontSize: 13 }}>
                  {paidStatus?.paidAt
                    ? t("billing.order.paid_at", { amount: usd(paidStatus.amountMicro ?? order.amountMicro), time: formatDateTime(paidStatus.paidAt) })
                    : t("billing.order.paid", { amount: usd(paidStatus?.amountMicro ?? order.amountMicro) })}
                </p>
              ) : payState === "closed" ? (
                <p style={muted}>{t("billing.order.closed")}</p>
              ) : payState === "timeout" ? (
                <p style={muted}>{t("billing.order.timeout")}</p>
              ) : null}
            </div>
          ) : null}
        </CardContent>
      </Card>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0,1fr))", gap: 12 }}>
        <Card>
          <CardHeader><CardTitle>{t("billing.redeem.title")}</CardTitle></CardHeader>
          <CardContent>
            <Field label={t("billing.redeem.code")}>
              <Input
                value={code}
                onChange={(e) => setCode(e.target.value)}
                placeholder={t("billing.redeem.placeholder")}
                disabled={busy}
              />
            </Field>
            <p style={muted}>
              {t("billing.redeem.hint")}
            </p>
            <div style={{ marginTop: 8 }}>
              <Button onClick={() => void redeem()} disabled={busy || code.trim() === ""}>
                {busy ? t("billing.redeem.redeeming") : t("billing.redeem.submit")}
              </Button>
            </div>
            {redeemed ? (
              <p style={{ margin: "8px 0 0", fontSize: 13 }}>
                {t("billing.redeem.done", { amount: usd(redeemed.quotaMicro), balance: usd(redeemed.balance) })}
              </p>
            ) : null}
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle>{t("billing.mock.title")}</CardTitle></CardHeader>
          <CardContent>
            <Field label={t("billing.mock.amount")}>
              <Input value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="1000000 = $1" />
            </Field>
            <p style={muted}>
              {t("billing.mock.hint", { grant: t("billing.tx.grant"), recharge: t("billing.tx.recharge") })}
            </p>
            <div style={{ marginTop: 8 }}><Button onClick={() => void recharge()}>{t("billing.mock.submit")}</Button></div>
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

/**
 * 二维码：不引第三方库，用 SVG 画。支付宝/微信的 code_url 都在 100 字以内，用 Byte 模式、
 * 版本自适应、纠错级 M 足够；只支持 8-bit 字节模式，这对 URL 而言就是全部。
 * 实现放在页面里而不是 kit：整个控制台只有这一处要画码。
 */
function QrBox({ text }: { text: string }) {
  const t = useT("payment");
  const matrix = React.useMemo(() => qrMatrix(text), [text]);
  if (!matrix) {
    return (
      <p style={{ margin: "6px 0 0", fontSize: 12 }}>
        {t("billing.qr.too_long")}<code style={{ wordBreak: "break-all" }}>{text}</code>
      </p>
    );
  }
  const n = matrix.length, cell = 5, quiet = 4, sizePx = (n + quiet * 2) * cell;
  let d = "";
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (matrix[y][x]) d += `M${(x + quiet) * cell} ${(y + quiet) * cell}h${cell}v${cell}h-${cell}z`;
  return (
    <div style={{ marginTop: 8 }}>
      <svg width={sizePx} height={sizePx} viewBox={`0 0 ${sizePx} ${sizePx}`} role="img" aria-label={t("billing.qr.label")} style={{ background: "#fff", borderRadius: 6 }}>
        <path d={d} fill="#000" />
      </svg>
      <p style={{ margin: "6px 0 0", fontSize: 12, color: "var(--muted-foreground)", wordBreak: "break-all" }}>{text}</p>
    </div>
  );
}

// ── 最小 QR 编码器（Byte 模式，纠错 M，版本 1–10，掩码固定 0）──────────────────────────
// 参考 ISO/IEC 18004。故意不做掩码评分：所有掩码都是合法码，扫码器不挑；少一百行。

const EC_M: Array<[number, number, number, number, number]> = [
  // [version, totalCodewords, ecPerBlock, blocks1, dataPerBlock1]（M 级，块只有一种长度或两种 —— 这里的版本范围内用 blocks2 补）
  [1, 26, 10, 1, 16], [2, 44, 16, 1, 28], [3, 70, 26, 1, 44], [4, 100, 18, 2, 32], [5, 134, 24, 2, 43],
  [6, 172, 16, 4, 27], [7, 196, 18, 4, 31], [8, 242, 22, 2, 38], [9, 292, 22, 3, 36], [10, 346, 26, 4, 43],
];
// 版本 8/9/10 在 M 级有第二组块：(blocks2, dataPerBlock2)
const EC_M_SECOND: Record<number, [number, number]> = { 8: [2, 39], 9: [2, 37], 10: [1, 44] };
const ALIGN: Record<number, number[]> = { 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30], 6: [6, 34], 7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50] };

const GF_EXP = new Uint8Array(512), GF_LOG = new Uint8Array(256);
(() => { let x = 1; for (let i = 0; i < 255; i++) { GF_EXP[i] = x; GF_LOG[x] = i; x <<= 1; if (x & 0x100) x ^= 0x11d; } for (let i = 255; i < 512; i++) GF_EXP[i] = GF_EXP[i - 255]; })();
function gfMul(a: number, b: number) { return a === 0 || b === 0 ? 0 : GF_EXP[GF_LOG[a] + GF_LOG[b]]; }
function rsGenerator(n: number) { let g = [1]; for (let i = 0; i < n; i++) { const ng = new Array(g.length + 1).fill(0); for (let j = 0; j < g.length; j++) { ng[j] ^= g[j]; ng[j + 1] ^= gfMul(g[j], GF_EXP[i]); } g = ng; } return g; }
function rsEncode(data: number[], ecLen: number) { const g = rsGenerator(ecLen); const res = new Array(ecLen).fill(0); for (const d of data) { const f = d ^ res[0]; res.shift(); res.push(0); if (f) for (let j = 0; j < ecLen; j++) res[j] ^= gfMul(g[j + 1], f); } return res; }

function qrMatrix(text: string): boolean[][] | null {
  const bytes = Array.from(new TextEncoder().encode(text));
  const spec = EC_M.find(([v, total, ec, b1, d1]) => {
    const second = EC_M_SECOND[v]; const cap = b1 * d1 + (second ? second[0] * second[1] : 0);
    void total; void ec; return bytes.length + (v < 10 ? 2 : 3) <= cap;
  });
  if (!spec) return null;
  const [version, totalCw, ecLen, blocks1, data1] = spec;
  const second = EC_M_SECOND[version];
  const dataCap = blocks1 * data1 + (second ? second[0] * second[1] : 0);
  // 比特流：模式 0100 + 长度(8 bit, v<10) + 数据 + 终止符 + 填充
  const bits: number[] = [];
  const push = (v: number, n: number) => { for (let i = n - 1; i >= 0; i--) bits.push((v >> i) & 1); };
  push(0b0100, 4); push(bytes.length, version < 10 ? 8 : 16); for (const b of bytes) push(b, 8);
  push(0, Math.min(4, dataCap * 8 - bits.length)); while (bits.length % 8) bits.push(0);
  const data: number[] = []; for (let i = 0; i < bits.length; i += 8) data.push(parseInt(bits.slice(i, i + 8).join(""), 2));
  for (let p = 0; data.length < dataCap; p++) data.push(p % 2 ? 0x11 : 0xec);
  // 分块 + RS
  const blocks: number[][] = [], ecs: number[][] = []; let off = 0;
  const layout: Array<[number, number]> = [[blocks1, data1], ...(second ? [second] : [])];
  for (const [cnt, len] of layout) for (let i = 0; i < cnt; i++) { const blk = data.slice(off, off + len); off += len; blocks.push(blk); ecs.push(rsEncode(blk, ecLen)); }
  const out: number[] = []; const maxLen = Math.max(...blocks.map((b) => b.length));
  for (let i = 0; i < maxLen; i++) for (const b of blocks) if (i < b.length) out.push(b[i]);
  for (let i = 0; i < ecLen; i++) for (const e of ecs) out.push(e[i]);
  void totalCw;
  // 画模块
  const n = version * 4 + 17;
  const m: boolean[][] = Array.from({ length: n }, () => new Array(n).fill(false));
  const fn: boolean[][] = Array.from({ length: n }, () => new Array(n).fill(false));
  const set = (x: number, y: number, v: boolean) => { m[y][x] = v; fn[y][x] = true; };
  const finder = (cx: number, cy: number) => { for (let dy = -1; dy <= 7; dy++) for (let dx = -1; dx <= 7; dx++) { const x = cx + dx, y = cy + dy; if (x < 0 || y < 0 || x >= n || y >= n) continue; const on = dx >= 0 && dx <= 6 && dy >= 0 && dy <= 6 && (dx === 0 || dx === 6 || dy === 0 || dy === 6 || (dx >= 2 && dx <= 4 && dy >= 2 && dy <= 4)); set(x, y, on); } };
  finder(0, 0); finder(n - 7, 0); finder(0, n - 7);
  for (let i = 8; i < n - 8; i++) { set(i, 6, i % 2 === 0); set(6, i, i % 2 === 0); }
  const alignLast = (ALIGN[version] ?? [])[(ALIGN[version] ?? []).length - 1];
  for (const cy of ALIGN[version] ?? []) for (const cx of ALIGN[version] ?? []) {
    // 只跳过与三个定位图形重叠的角；(6,22) 这类落在时序线上的对齐图形是要画的
    if ((cx === 6 && cy === 6) || (cx === 6 && cy === alignLast) || (cx === alignLast && cy === 6)) continue;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) set(cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
  }
  set(8, n - 8, true);
  // 格式信息区先占位（掩码 0、M 级：格式位 101010000010010）
  const fmt = 0b101010000010010;
  for (let i = 0; i < 15; i++) {
    const bit = ((fmt >> i) & 1) === 1;
    if (i < 6) set(8, i, bit); else if (i < 8) set(8, i + 1, bit); else if (i === 8) set(7, 8, bit); else set(14 - i, 8, bit);
    if (i < 8) set(n - 1 - i, 8, bit); else set(8, n - 15 + i, bit);
  }
  if (version >= 7) {
    let v = version; for (let i = 0; i < 12; i++) v = (v << 1) ^ ((v >> 11) & 1 ? 0x1f25 : 0); const vi = (version << 12) | v;
    for (let i = 0; i < 18; i++) { const bit = ((vi >> i) & 1) === 1; set(Math.floor(i / 3), n - 11 + (i % 3), bit); set(n - 11 + (i % 3), Math.floor(i / 3), bit); }
  }
  // 数据放置（之字形）+ 掩码 0：(x+y)%2==0 翻转
  let bi = 0; const total = out.length * 8;
  for (let right = n - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < n; vert++) {
      const y = (Math.floor((n - 1 - right) / 2) % 2 === 0) ? n - 1 - vert : vert;
      for (const x of [right, right - 1]) {
        if (fn[y][x]) continue;
        let bit = false;
        if (bi < total) { bit = ((out[bi >> 3] >> (7 - (bi & 7))) & 1) === 1; bi++; }
        m[y][x] = bit !== ((x + y) % 2 === 0);
      }
    }
  }
  return m;
}
