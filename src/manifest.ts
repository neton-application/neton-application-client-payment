import { defineFrontModule } from "@neton/application-client-contract";

/**
 * 财务（通用）：钱包余额、充值、流水。
 * 提现/银行卡/转账/红包属 IM 类产品的能力，不在通用装配内。
 */
export default defineFrontModule({
  id: "payment",
  contractVersion: "1.0.0",
  locales: [
    { lang: "zh-CN", entry: "zh-CN" },
    { lang: "en-US", entry: "en-US" },
  ],
  pages: [
    { key: "payment/billing/index", path: "/payment/billing", entry: "billing", rendering: "client" },
  ],
});
