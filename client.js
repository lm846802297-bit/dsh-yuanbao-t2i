// 浏览器半：元宝生图的设置卡（Plugins 页 dsh-yuanbao-t2i 卡片内）。
// 手写 lazy-CJS 协议（window.__ModuleLoader__.load + factory），无构建步骤；
// 读写走宿主路由 /yuanbao-t2i/config（配置文件 ~/.dsh/yuanbao-t2i-config.json）。
window.__ModuleLoader__.load({
  id: "dsh-yuanbao-t2i",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;

    // Plugins 页按 npm 包名分派 bundle 的设置卡
    var PACKAGE_NAME = "dsh-yuanbao-t2i";
    var ROUTE = "/yuanbao-t2i/config";

    var TEXT = {
      zh: {
        title: "生成设置",
        summary: "输出目录、是否自动去水印。",
        watermark: "生成后自动去水印",
        watermarkHint:
          "开启后每次生成会把图送去水印，产物落在 <输出目录>/clean/ 并保留原图。Big-LaMa 约 3–8 秒/张（GPU）。",
        outDir: "输出目录",
        outDirHint: "留空＝默认目录（~/.dsh/yuanbao-t2i-out）。填绝对路径则图片和 clean/ 子目录都落在那里。",
        outDirPlaceholder: "例如 D:/CG/元宝生图",
        browse: "选择目录…",
        browseCompact: "选择…",
        browsing: "等待选择…",
        browseFailed: "打开系统目录选择器失败",
        browseEmpty: "已取消选择",
        browseUnavailable: "当前宿主不支持目录选择器（请手动输入路径）",
        note: "此设置为默认值；单次调用仍可用参数 outDir / removeWatermark 临时覆盖。",
        save: "保存",
        saving: "保存中…",
        saved: "已保存",
        loading: "读取中…",
        loadFailed: "读取设置失败",
        saveFailed: "保存失败",
        file: "配置文件",
      },
      en: {
        title: "Generation settings",
        summary: "Output directory and watermark removal.",
        watermark: "Remove watermark after generation",
        watermarkHint:
          "When on, every batch is sent through watermark removal; cleaned files land in <outDir>/clean/ and originals are kept. Big-LaMa takes ~3–8 s per image (GPU).",
        outDir: "Output directory",
        outDirHint: "Empty = default (~/.dsh/yuanbao-t2i-out). An absolute path sends both images and the clean/ subfolder there.",
        outDirPlaceholder: "e.g. D:/CG/yuanbao",
        browse: "Browse…",
        browseCompact: "…",
        browsing: "Waiting for selection…",
        browseFailed: "could not open the system folder picker",
        browseEmpty: "selection cancelled",
        browseUnavailable: "this host has no folder picker (type the path instead)",
        note: "These are defaults; a single call can still override them with outDir / removeWatermark.",
        save: "Save",
        saving: "saving…",
        saved: "saved",
        loading: "loading…",
        loadFailed: "could not read settings",
        saveFailed: "save failed",
        file: "Config file",
      },
    };

    function labelSet() {
      var lang =
        (typeof navigator !== "undefined" && navigator.language) ||
        (typeof document !== "undefined" && document.documentElement.lang) ||
        "";
      return lang.toLowerCase().indexOf("zh") === 0 ? TEXT.zh : TEXT.en;
    }

    // 标题/说明用于 Plugins 页卡片的一句话摘要（view === 'summary'）
    function ConfigCard(react) {
      var h = react.createElement;

      var theme = {
        card: {
          border: "1px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.28))",
          borderRadius: 12,
          background: "var(--dsw-alias-bg-l1, transparent)",
          padding: "14px 16px",
          display: "flex",
          flexDirection: "column",
          gap: 12,
          maxWidth: 640,
        },
        title: { fontSize: 14, fontWeight: 600 },
        hint: {
          fontSize: 12,
          lineHeight: 1.55,
          color: "var(--dsw-alias-label-tertiary, rgba(127,127,127,0.9))",
        },
        row: { display: "flex", alignItems: "center", gap: 8 },
        footer: { display: "flex", alignItems: "center", gap: 10 },
        button: {
          font: "inherit",
          fontSize: 13,
          cursor: "pointer",
          borderRadius: 8,
          padding: "6px 14px",
          border: "1px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.28))",
          background: "var(--dsw-alias-bg-l2, rgba(127,127,127,0.1))",
          color: "var(--dsw-alias-label-primary, inherit)",
        },
      };

      return function YuanbaoT2iCard(props) {
        var t = labelSet();
        if (props && props.view === "summary") {
          return t.summary;
        }
        var loadedState = react.useState(false);
        var settingsState = react.useState({ removeWatermark: false, wmEngine: "lama", outDir: "" });
        var draftState = react.useState({ removeWatermark: false, wmEngine: "lama", outDir: "" });
        var noteState = react.useState("");
        var busyState = react.useState(false);
        var pickingState = react.useState(false);
        var loaded = loadedState[0];
        var settings = settingsState[0];
        var draft = draftState[0];
        var note = noteState[0];
        var busy = busyState[0];
        var picking = pickingState[0];

        react.useEffect(() => {
          var alive = true;
          noteState[1](t.loading);
          fetch(ROUTE)
            .then((r) => r.json().then((body) => ({ ok: r.ok, body })))
            .then((res) => {
              if (!alive) return;
              if (!res.ok) throw new Error(res.body && res.body.error);
              var next = {
                removeWatermark: res.body.removeWatermark === true,
                wmEngine: "lama",
                outDir: typeof res.body.outDir === "string" ? res.body.outDir : "",
              };
              settingsState[1](next);
              draftState[1](next);
              loadedState[1](true);
              noteState[1](res.body.path ? t.file + "：" + res.body.path : "");
            })
            .catch((e) => {
              if (alive) noteState[1](t.loadFailed + (e && e.message ? "：" + e.message : ""));
            });
          return () => {
            alive = false;
          };
        }, []);

        var saved =
          loaded &&
          draft.removeWatermark === settings.removeWatermark &&
          draft.wmEngine === settings.wmEngine &&
          draft.outDir === settings.outDir;

        function save() {
          busyState[1](true);
          noteState[1](t.saving);
          fetch(ROUTE, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(draft),
          })
            .then((r) => r.json().then((body) => ({ ok: r.ok, body })))
            .then((res) => {
              if (!res.ok) throw new Error(res.body && res.body.error);
              var next = {
                removeWatermark: res.body.removeWatermark === true,
                wmEngine: "lama",
                outDir: typeof res.body.outDir === "string" ? res.body.outDir : "",
              };
              settingsState[1](next);
              draftState[1](next);
              noteState[1](t.saved);
            })
            .catch((e) => noteState[1](t.saveFailed + (e && e.message ? "：" + e.message : "")))
            .then(() => busyState[1](false));
        }

        function browse() {
          var pick =
            typeof window !== "undefined" ? window.__DSH_DESKTOP_PICK_DIRECTORY__ : void 0;
          if (typeof pick !== "function") {
            noteState[1](t.browseUnavailable);
            return;
          }
          pickingState[1](true);
          noteState[1](t.browsing);
          pick()
            .then((result) => {
              var path = result && typeof result === "object" ? result.path : result;
              if (typeof path !== "string" || path === "") {
                noteState[1](t.browseEmpty);
                return;
              }
              draftState[1](Object.assign({}, draft, { outDir: path }));
              noteState[1](path);
            })
            .catch((e) =>
              noteState[1](t.browseFailed + (e && e.message ? "：" + e.message : "")),
            )
            .then(() => pickingState[1](false));
        }

        return h(
          "div",
          { style: theme.card },
          h("div", { style: theme.title }, t.title),
          h(
            "label",
            { style: { ...theme.row, cursor: "pointer" } },
            h("input", {
              type: "checkbox",
              checked: draft.removeWatermark,
              disabled: !loaded || busy,
              onChange: (e) => {
                var on = e.target.checked;
                draftState[1](Object.assign({}, draft, { removeWatermark: on }));
              },
            }),
            h("span", { style: { fontSize: 13 } }, t.watermark),
          ),
          h("div", { style: theme.hint }, t.watermarkHint),
          h(
            "label",
            { style: { display: "flex", flexDirection: "column", gap: 6 } },
            h("span", { style: { fontSize: 13 } }, t.outDir),
            h("input", {
              type: "text",
              value: draft.outDir,
              placeholder: t.outDirPlaceholder,
              spellcheck: false,
              disabled: !loaded || busy,
              onChange: (e) => {
                var value = e.target.value;
                draftState[1](Object.assign({}, draft, { outDir: value }));
              },
              style: {
                font: "inherit",
                fontSize: 13,
                padding: "6px 8px",
                borderRadius: 8,
                border: "1px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.28))",
                background: "var(--dsw-alias-bg-l2, rgba(127,127,127,0.08))",
                color: "var(--dsw-alias-label-primary, inherit)",
                width: "100%",
                maxWidth: 460,
                boxSizing: "border-box",
              },
            }),
            h(
              "div",
              { style: theme.row },
              h(
                "button",
                {
                  type: "button",
                  style: theme.button,
                  disabled: !loaded || busy || picking,
                  onClick: browse,
                },
                picking ? t.browsing : t.browseCompact,
              ),
              // 桥不可用（非 win32 / 旧宿主）时就地提示，不等用户点
              typeof window !== "undefined" && typeof window.__DSH_DESKTOP_PICK_DIRECTORY__ !== "function"
                ? h("span", { style: theme.hint }, t.browseUnavailable)
                : null,
            ),
          ),
          h("div", { style: theme.hint }, t.outDirHint),
          // ⛔ v0.10.0 起掩膜模式下拉整块已移除：改由 wm_lama.py 内部自适应（auto）；
          //    兜底只留环境变量 DSH_WM_MASK=tight|rect，不再暴露成界面选项。
          h("div", { style: theme.hint }, t.note),
          h(
            "div",
            { style: theme.footer },
            h(
              "button",
              {
                type: "button",
                style: theme.button,
                disabled: !loaded || busy || saved,
                onClick: save,
              },
              saved ? t.saved : busy ? t.saving : t.save,
            ),
            h("span", { style: theme.hint }, note),
          ),
        );
      };
    }

    function registerCard(ctx) {
      if (typeof ctx.inject !== "function") return;
      ctx.inject(["slots"], (scope) => {
        var react;
        try {
          react = require("react");
        } catch (error) {
          console.error("[yuanbao-t2i] settings card skipped: " + error);
          return;
        }
        var Card = ConfigCard(react);
        scope.slots.inject("plugins.bundle.config", function* () {
          yield scope.slots.register({ name: "plugins.bundle.config", key: PACKAGE_NAME }, Card);
        });
        // 旧宿主（0.1.5 及以前）的设置页入口；新宿主不声明该 slot，等待自然不触发
        scope.slots.inject("settings.plugin.item", function* () {
          yield scope.slots.register(
            { name: "settings.plugin.item", id: "dsh-yuanbao-t2i", key: "dsh-yuanbao-t2i", order: 41 },
            Card,
          );
        });
      });
    }

    function apply(ctx) {
      registerCard(ctx);
    }

    exports.apply = apply;
    exports.inject = [];
    exports.__card = { ConfigCard: ConfigCard, labelSet: labelSet };
    return module.exports;
  },
});
