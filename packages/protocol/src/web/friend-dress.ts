import { createLogger } from '@snowluma/common/logger';
import { RequestUtil, cookieToString } from './request-util';

const log = createLogger('Bridge.Web');

export interface WebFriendDressItem {
  [key: string]: import('@snowluma/common/json').JsonValue;
  /** 装扮业务 id（QQ 会员 appId，决定类别）。 */
  app_id: number;
  /** 人类可读类别（按 appId 映射，未知则为 appId=<n>）。 */
  kind: string;
  /** 装扮 id（默认款为 0）。 */
  item_id: number;
  name: string;
  /** 静态预览图 url。 */
  preview_url: string;
  /** 动态预览视频 url（名片/来电才有，否则空串）。 */
  video_url: string;
  /** 商城价（非默认款才有，否则 0）。 */
  price: number;
}

export interface WebFriendDress {
  [key: string]: import('@snowluma/common/json').JsonValue;
  target_uin: string;
  is_svip: boolean;
  /** 对方头像图 url（装扮页附带，非"头像装扮"）。 */
  avatar_url: string;
  /** 对方正在用的装扮（已剔除服务器不回真值的气泡/字体/头像）。 */
  items: WebFriendDressItem[];
}

/** appId → 装扮类别（取自装扮页 business-name / tab 文案）。 */
const APP_KIND: Record<number, string> = {
  2: '气泡',
  4: '挂件',
  5: '字体',
  15: '名片',
  17: '来电',
  22: '彩色屏保',
  23: '头像',
  47: '头像双击动作',
  352: '输入状态',
};

/**
 * 服务器不会回真值的装扮类型：气泡(2)/字体(5)/头像(23)。这几类只按 targetUin 查
 * 永远回默认款，必须客户端在请求里带对应 id 才知道对方用了啥 —— 拿到也是废数据，剔除。
 */
const UNRESOLVABLE_APPS = new Set([2, 5, 23]);

/**
 * HAR 里的 traceDetail：base64({"appid":"toaio","page_id":"37","item_id":"","item_type":""})。
 * 与 targetUin 无关，固定值；已是编码后的串，拼接时不可再被二次编码。
 */
const TRACE_DETAIL =
  'base64-eyJhcHBpZCI6InRvYWlvIiwicGFnZV9pZCI6IjM3IiwiaXRlbV9pZCI6IiIsIml0ZW1fdHlwZSI6%0AIiJ9%0A';

/** aio webview 的移动端 UA（照 HAR；桌面 UA 可能返回不同壳）。 */
const DRESS_UA =
  'Mozilla/5.0 (Linux; Android 13; 2109119BC Build/TKQ1.221114.001; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/121.0.6167.71 MQQBrowser/6.2 TBS/047925 Mobile Safari/537.36 V1_AND_SQ_9.2.66_13188_YYB_D QQ/9.2.66.33870 NetType/WIFI WebP/0.3.0 AppId/537339358';

interface RawDressItem {
  appId?: number;
  itemId?: number;
  name?: string;
  image?: string;
  extrainfo?: { price?: number };
  extraappinfo?: { extraInfo?: { immersiveMaterial?: string } };
}

interface RawAsyncData {
  targetUin?: string;
  isSvip?: boolean;
  avatarImage?: string;
  rawUsingList?: RawDressItem[];
}

/** 按 targetUin 拼装扮页 URL（结构照 HAR）。 */
function buildDressUrl(targetUin: string): string {
  const inner =
    `https://zb.vip.qq.com/v2/pages/aioDressPage?fromPage=1&targetUin=${targetUin}` +
    `&widgetId=0&fontEffectId=0&bgId=custom&chatId=${targetUin}` +
    `&isGroup=0&traceDetail=${TRACE_DETAIL}`;
  const params = new URLSearchParams({
    fromPage: '1',
    enteranceId: 'aio',
    url: inner,
    fontEffectId: '0',
    chatId: targetUin,
    widgetId: '0',
    targetUin,
    isGroup: '0',
    bgId: 'custom',
  });
  // traceDetail 已是编码后的 base64-... 串，单独拼避免被二次编码。
  return `https://zb.vip.qq.com/v2/pages/aioDressPage?${params.toString()}&traceDetail=${TRACE_DETAIL}`;
}

/** 从 SSR HTML 抠出 window.__INITIAL_ASYNCDATA__ 的 JSON（拿不到返回 null）。 */
function parseAsyncData(html: string): RawAsyncData | null {
  const m = html.match(/window\.__INITIAL_ASYNCDATA__\s*=\s*(\{[\s\S]*?\});\(function/);
  if (!m?.[1]) return null;
  try {
    return JSON.parse(m[1]) as RawAsyncData;
  } catch {
    return null;
  }
}

/**
 * 抠出该装扮项的动态预览视频 url（没有则空串）。
 *  - 名片(appId 15)：video 藏在 extraInfo.immersiveMaterial（JSON 字符串）的 videoUrl。
 *  - 来电(appId 17)：无独立字段，按预览图同目录换名 image.jpg → media.mp4。
 */
function resolveVideoUrl(r: RawDressItem): string {
  if (r.appId === 15) {
    const raw = r.extraappinfo?.extraInfo?.immersiveMaterial;
    if (!raw) return '';
    try {
      return (JSON.parse(raw) as { videoUrl?: string }).videoUrl ?? '';
    } catch {
      return '';
    }
  }
  if (r.appId === 17 && r.image) {
    return r.image.replace(/\/image\.jpg$/, '/media.mp4');
  }
  return '';
}

function toItem(r: RawDressItem): WebFriendDressItem {
  const appId = r.appId ?? 0;
  return {
    app_id: appId,
    kind: APP_KIND[appId] ?? `appId=${appId}`,
    item_id: r.itemId ?? 0,
    name: r.name ?? '',
    preview_url: r.image ?? '',
    video_url: resolveVideoUrl(r),
    price: r.extrainfo?.price ?? 0,
  };
}

/**
 * 查 targetUin 正在用的好友装扮（挂件/名片/来电/输入状态等）。抠不到
 * __INITIAL_ASYNCDATA__（未登录态/风控/页面改版）时返回 null，让调用方区分
 * 「查到但空」与「压根没解析出来」。
 */
export async function getFriendDressWebAPI(
  cookieObject: Record<string, string>,
  targetUin: string,
): Promise<WebFriendDress | null> {
  let html: string;
  try {
    html = await RequestUtil.HttpGetText(buildDressUrl(targetUin), 'GET', '', {
      Cookie: cookieToString(cookieObject),
      'User-Agent': DRESS_UA,
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'zh-CN,zh;q=0.9',
    });
  } catch (e) {
    log.warn('getFriendDressWebAPI failed (uin=%s): %s',
      targetUin, e instanceof Error ? (e.stack ?? e.message) : String(e));
    return null;
  }

  const data = parseAsyncData(html);
  if (!data?.rawUsingList) return null;

  return {
    target_uin: data.targetUin ?? targetUin,
    is_svip: data.isSvip ?? false,
    avatar_url: data.avatarImage ?? '',
    items: data.rawUsingList
      .filter((r) => !UNRESOLVABLE_APPS.has(r.appId ?? 0))
      .map(toItem),
  };
}
