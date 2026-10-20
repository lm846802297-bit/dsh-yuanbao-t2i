// 设置读写路由：/yuanbao-t2i/config（浏览器端插件界面 ←→ 本地配置文件）
// 说明：webServer 是裸注册表，不继承 DSH 连接认证 ⇒ 本路由只应在 loopback 部署下使用。
import { readSettings, writeSettings, SETTINGS_PATH } from "./settings.js";

const MAX_BODY = 16 * 1024;

function send(res, status, body) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

async function readBody(req) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > MAX_BODY) {
      const e = new Error("config payload too large");
      e.status = 413;
      throw e;
    }
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

export function registerSettingsRoute(ctx) {
  const route = {
    name: "yuanbao-t2i-config",
    kind: "exact",
    path: "/yuanbao-t2i/config",
    handler: async (req, res) => {
      try {
        if (req.method === "GET") {
          const settings = await readSettings();
          send(res, 200, { ...settings, path: SETTINGS_PATH });
          return;
        }
        if (req.method !== "POST") {
          res.writeHead(405).end();
          return;
        }
        const patch = await readBody(req);
        const settings = await writeSettings(patch);
        send(res, 200, { ...settings, path: SETTINGS_PATH });
      } catch (e) {
        send(res, e?.status || 400, { error: String(e?.message || e) });
      }
    },
  };
  // 路由生命周期跟插件走：插件卸载/重载时注销，避免重复注册
  ctx.effect(() => ctx.webServer.register(route), "yuanbao-t2i: settings route");
}

const __tmp_verify_notify = ;
