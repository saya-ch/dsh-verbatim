    /* ══════════════════════════ 样式（只用 DSH 设计令牌） ══════════════════════════ */

    const BORDER = 'var(--dsw-alias-border-l2, rgba(128,128,128,.25))';
    const BORDER_STRONG = 'var(--dsw-alias-border-l3, rgba(128,128,128,.38))';
    const LABEL1 = 'var(--dsw-alias-label-primary, inherit)';
    const LABEL2 = 'var(--dsw-alias-label-secondary, rgba(128,128,128,.95))';
    const LABEL3 = 'var(--dsw-alias-label-tertiary, rgba(128,128,128,.8))';
    const LINK = 'var(--dsw-alias-link, var(--dsw-alias-label-primary, inherit))';
    const BRAND = 'var(--dsw-alias-state-business-primary, #4d6bfe)';
    const WARN = 'var(--dsw-alias-state-warn-primary, #c58b00)';
    const WARN_BORDER = 'var(--dsw-alias-state-warn-secondary, rgba(197,139,0,.55))';
    const SUCCESS = 'var(--dsw-alias-state-success-primary, #1a9e5d)';
    const ERROR = 'var(--dsw-alias-state-error-primary, #c0392b)';
    const RADIUS = 'var(--dsw-radius-lg, 10px)';
    const RADIUS_SM = 'var(--dsw-radius-sm, 6px)';
    const CODE_FONT = 'var(--ds-font-family-code, ui-monospace, SFMono-Regular, Menlo, monospace)';

    /* ── 排版与间距尺度（2026-11-18 统一） ──
     *
     * 改之前：字号 11 档（10/10.5/11/11.5/12/12.5/13/13.5/14/18/22），
     * padding 33 种 —— 视觉上没有节奏，读起来"哪里都差一点"。
     * 现在收敛成 6 档字号 + 4 档间距，所有新样式只能从这里取。
     */
    const FS = {
      xs: 10.5,      // 辅助信息：日期、单位、极次要说明
      sm: 11.5,      // 次要：行内说明、标签、表格值
      base: 12.5,    // 正文
      md: 13.5,      // 小标题、强调正文
      lg: 18,        // 页面标题
      display: 26,   // 核心数字（一个面板只该有一个）
    };
    /** 统一过渡：所有交互态都走这个，保证手感一致 */
    const T = 'background .15s ease, border-color .15s ease, color .15s ease, opacity .15s ease';

    /**
     * 注入一段全局 CSS（带 id 去重，重复调用只更新内容）。
     *
     * 返回清理函数 —— 插件卸载时把 <style> 移掉，不留垃圾。
     * 只在模块里用一次（交互态样式表），别拿它做组件的动态样式。
     */
    function injectStyle(id, css) {
      if (typeof document === 'undefined') return () => {};
      let el = document.getElementById(id);
      if (el === null) {
        el = document.createElement('style');
        el.id = id;
        document.head.appendChild(el);
      }
      el.textContent = css;
      return () => {
        try { el.remove(); } catch { /* 已经被移除 */ }
      };
    }

    const S = {
      root: {
        display: 'flex',
        flexDirection: 'column',
        boxSizing: 'border-box',
        height: '100%',
        minHeight: 0,
        minWidth: 0,
        overflow: 'hidden',
        fontSize: FS.md,
        lineHeight: 1.5,
        color: LABEL1,
        fontFamily: 'inherit',
      },
      head: {
        flex: '0 0 auto',
        padding: '12px 14px 8px',
        background: `linear-gradient(180deg, color-mix(in srgb, ${BRAND} 4%, transparent), transparent)`,
        borderBottom: `1px solid ${BORDER}`,
      },
      titleRow: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, minWidth: 0 },
      title: { fontSize: FS.md, fontWeight: 600, lineHeight: '20px', letterSpacing: 0.1 },
      statusPill: {
        display: 'inline-flex',
        alignItems: 'center',
        gap: 5,
        padding: '2px 8px',
        borderRadius: 999,
        fontSize: FS.xs,
        fontWeight: 500,
        lineHeight: '16px',
        background: 'var(--dsw-alias-bg-layer-1, rgba(128,128,128,.08))',
        border: `1px solid ${BORDER}`,
        color: LABEL2,
        flex: '0 0 auto',
      },
      sessionName: {
        fontSize: FS.sm,
        lineHeight: '16px',
        color: LABEL3,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
        maxWidth: 220,
      },
      swRow: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, padding: '2px 0' },
      swLabel: { fontSize: FS.base },
      hint: { margin: '2px 0 0', fontSize: FS.sm, lineHeight: '16px', color: LABEL3 },
      warnHint: { margin: '2px 0 0', fontSize: FS.sm, lineHeight: '16px', color: WARN },
      statLine: { marginTop: 10, fontSize: FS.base, color: LABEL2, wordBreak: 'break-word' },
      card: {
        boxSizing: 'border-box',
        borderWidth: 1,
        borderStyle: 'solid',
        borderColor: BORDER,
        borderRadius: 10,
        background: 'var(--dsw-alias-card-fill, transparent)',
        boxShadow: '0 1px 3px rgba(0,0,0,.03)',
        padding: '10px 12px',
        marginTop: 8,
      },
      statusDot: {
        display: 'inline-block',
        width: 7,
        height: 7,
        borderRadius: '50%',
        flex: '0 0 auto',
      },
      switchCard: {
        boxSizing: 'border-box',
        borderWidth: 1,
        borderStyle: 'solid',
        borderColor: BORDER,
        borderRadius: 10,
        background: 'var(--dsw-alias-card-fill, transparent)',
        boxShadow: '0 1px 3px rgba(0,0,0,.03)',
        padding: '7px 12px',
      },
      kpiGrid: {
        display: 'grid',
        gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
        gap: 7,
        marginTop: 8,
      },
      kpiTile: {
        appearance: 'none',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'flex-start',
        textAlign: 'left',
        boxSizing: 'border-box',
        minWidth: 0,
        padding: '9px 10px',
        borderWidth: 1,
        borderStyle: 'solid',
        borderColor: BORDER,
        borderRadius: 12,
        background: 'var(--dsw-alias-bg-layer-1, rgba(128,128,128,.04))',
        boxShadow: '0 1px 3px rgba(0,0,0,.03)',
        color: LABEL1,
        font: 'inherit',
        cursor: 'pointer',
      },
      kpiLabel: { fontSize: FS.xs, color: LABEL3, lineHeight: '15px' },
      kpiVal: {
        fontSize: FS.md,
        fontWeight: 600,
        color: LABEL1,
        lineHeight: '20px',
        marginTop: 2,
        fontVariantNumeric: 'tabular-nums',
      },
      kpiSub: {
        fontSize: FS.xs,
        color: LABEL3,
        lineHeight: '14px',
        marginTop: 1,
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        maxWidth: '100%',
      },
      sparkCard: {
        boxSizing: 'border-box',
        borderWidth: 1,
        borderStyle: 'solid',
        borderColor: BORDER,
        borderRadius: 10,
        background: 'var(--dsw-alias-card-fill, transparent)',
        boxShadow: '0 1px 3px rgba(0,0,0,.03)',
        padding: '9px 11px 7px',
      },
      // 核心数字：整个面板唯一允许用 display 字号的地方。
      // 之前这个数字既出现在句子里又单独大字显示一遍 —— 视觉上在重复同一件事。
      coreRow: {
        display: 'flex',
        alignItems: 'baseline',
        flexWrap: 'wrap',
        gap: '2px 6px',
        marginTop: 2,
        marginBottom: 2,
      },
      coreLabel: { fontSize: FS.base, color: LABEL2 },
      coreCard: {
        position: 'relative',
        overflow: 'hidden',
        boxSizing: 'border-box',
        borderWidth: 1,
        borderStyle: 'solid',
        borderColor: `color-mix(in srgb, ${BRAND} 24%, ${BORDER})`,
        borderRadius: 14,
        background: `radial-gradient(120% 100% at 100% 0%, color-mix(in srgb, #e07a96 10%, transparent) 0%, transparent 60%), linear-gradient(135deg, color-mix(in srgb, ${BRAND} 10%, transparent), color-mix(in srgb, ${BRAND} 3%, transparent))`,
        padding: '13px 14px',
        marginTop: 6,
      },
      coreNum: {
        fontSize: FS.display,
        fontWeight: 600,
        lineHeight: '30px',
        letterSpacing: '-0.02em',
        fontVariantNumeric: 'tabular-nums',
      },
      coreHint: { fontSize: FS.sm, color: LABEL2, marginTop: 3, lineHeight: 1.45 },
      rewindLine: { marginTop: 6, fontSize: FS.sm, color: LABEL3 },
      rewindHint: { fontSize: FS.sm, color: LABEL3 },
      indexBox: {
        boxSizing: 'border-box',
        borderWidth: 1,
        borderStyle: 'solid',
        borderColor: BORDER,
        borderRadius: 10,
        padding: '10px 12px',
        marginTop: 4,
        background: 'var(--dsw-alias-card-fill, transparent)',
        boxShadow: '0 1px 3px rgba(0,0,0,.03)',
      },
      advToggleBtn: {
        appearance: 'none',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        width: '100%',
        padding: '6px 0 2px',
        marginTop: 8,
        border: 0,
        borderTop: `1px dashed ${BORDER}`,
        background: 'transparent',
        color: LABEL3,
        font: 'inherit',
        fontSize: FS.xs,
        cursor: 'pointer',
      },
      indexRow: { display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8 },
      indexLabel: { fontSize: FS.sm, color: LABEL3, flex: '0 0 auto' },
      indexValue: { fontSize: FS.sm, color: LABEL1, textAlign: 'right', wordBreak: 'break-word', minWidth: 0 },
      indexStateOk: { fontSize: FS.sm, color: SUCCESS },
      indexStateWarn: { fontSize: FS.sm, color: WARN },
      indexStateOff: { fontSize: FS.sm, color: LABEL2 },
      progressTrack: {
        height: 5,
        marginTop: 6,
        borderRadius: 999,
        background: 'var(--dsw-alias-bg-layer-2, rgba(128,128,128,.25))',
        overflow: 'hidden',
      },
      // 不确定进度：一条来回跑的短条（准备/同步阶段）
      progressPulse: {
        width: '32%',
        height: '100%',
        background: BRAND,
        borderRadius: 999,
        animation: 'dvp-run 1.15s ease-in-out infinite',
      },
      // 确定百分比进度条
      progressFill: {
        height: '100%',
        background: BRAND,
        borderRadius: 999,
        transition: 'width .25s ease',
      },
      tabbar: {
        flex: '0 0 auto',
        display: 'flex',
        gap: 3,
        padding: '6px 8px',
        borderBottom: `1px solid ${BORDER}`,
        background: 'var(--dsw-alias-bg-layer-1, transparent)',
      },
      tab: {
        appearance: 'none',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 3,
        flex: '1 1 0',
        minWidth: 0,
        padding: '5px 4px',
        border: 0,
        borderRadius: 999,
        background: 'transparent',
        color: LABEL2,
        font: 'inherit',
        fontSize: FS.sm,
        fontWeight: 500,
        lineHeight: '18px',
        cursor: 'pointer',
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        textAlign: 'center',
      },
      tabActive: {
        color: BRAND,
        fontWeight: 600,
        background: `color-mix(in srgb, ${BRAND} 12%, transparent)`,
      },
      tabBadge: {
        display: 'inline-block',
        marginLeft: 3,
        padding: '0 4px',
        borderRadius: 999,
        background: 'color-mix(in srgb, ' + WARN + ' 22%, transparent)',
        color: WARN,
        fontSize: FS.xs,
        lineHeight: '14px',
      },
      body: {
        position: 'relative',
        flex: '1 1 auto',
        minHeight: 0,
        overflowY: 'auto',
        padding: '8px 12px 18px',
      },
      backTopBtn: {
        appearance: 'none',
        position: 'sticky',
        bottom: 10,
        marginLeft: 'auto',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: 28,
        height: 28,
        borderRadius: 999,
        borderWidth: 1,
        borderStyle: 'solid',
        borderColor: BORDER_STRONG,
        background: 'var(--dsw-alias-bg-base, var(--dsw-alias-card-fill, Canvas))',
        color: LABEL2,
        boxShadow: '0 2px 8px rgba(0,0,0,.12)',
        cursor: 'pointer',
        fontSize: FS.sm,
        zIndex: 5,
      },
      // 概览页的分区：每块一个标题 + 内容，中间留白
      section: { marginBottom: 16 },
      sectionTitle: {
        fontSize: FS.sm,
        fontWeight: 600,
        color: LABEL3,
        letterSpacing: '.02em',
        marginBottom: 6,
      },
      // 最近活跃度的小柱状图
      sparkRow: { display: 'flex', alignItems: 'flex-end', gap: 4, height: 42 },
      sparkCol: { display: 'flex', flexDirection: 'column', alignItems: 'center', flex: '1 1 0', minWidth: 0 },
      sparkBar: {
        width: '100%',
        maxWidth: 22,
        borderRadius: 2,
        background: 'color-mix(in srgb, ' + BRAND + ' 70%, transparent)',
        transition: 'height .2s ease',
      },
      sparkLabel: { marginTop: 4, fontSize: FS.xs, color: LABEL3, fontVariantNumeric: 'tabular-nums' },
      dim: { fontSize: FS.sm, color: LABEL3 },
      emptyCard: {
        boxSizing: 'border-box',
        border: `1px dashed color-mix(in srgb, ${BRAND} 30%, transparent)`,
        borderRadius: RADIUS,
        padding: '14px 14px',
        marginTop: 4,
        background: `color-mix(in srgb, ${BRAND} 3%, transparent)`,
        color: LABEL2,
        fontSize: FS.base,
        lineHeight: 1.65,
        wordBreak: 'break-word',
      },
      errorCard: {
        boxSizing: 'border-box',
        border: `1px solid ${ERROR}`,
        borderRadius: RADIUS,
        padding: '8px 10px',
        marginTop: 6,
        color: ERROR,
        fontSize: FS.base,
        wordBreak: 'break-word',
      },
      errDetail: { marginTop: 2, fontSize: FS.sm, color: LABEL3, wordBreak: 'break-word' },
      btn: {
        appearance: 'none',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 4,
        flex: '0 0 auto',
        padding: '4px 11px',
        borderWidth: 1,
        borderStyle: 'solid',
        borderColor: BORDER_STRONG,
        borderRadius: 999,
        background: 'var(--dsw-alias-card-fill, transparent)',
        color: LABEL1,
        font: 'inherit',
        fontSize: FS.sm,
        fontWeight: 500,
        lineHeight: '18px',
        cursor: 'pointer',
        whiteSpace: 'nowrap',
      },
      primaryBtn: {
        appearance: 'none',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 4,
        flex: '0 0 auto',
        padding: '4px 12px',
        borderWidth: 1,
        borderStyle: 'solid',
        borderColor: 'transparent',
        borderRadius: 999,
        background: BRAND,
        color: '#fff',
        font: 'inherit',
        fontSize: FS.sm,
        fontWeight: 500,
        lineHeight: '18px',
        cursor: 'pointer',
        whiteSpace: 'nowrap',
        boxShadow: `0 1px 4px color-mix(in srgb, ${BRAND} 28%, transparent)`,
      },
      linkBtn: {
        appearance: 'none',
        padding: 0,
        border: 0,
        background: 'transparent',
        color: LINK,
        font: 'inherit',
        fontSize: FS.sm,
        lineHeight: '18px',
        cursor: 'pointer',
      },
      dayRow: {
        appearance: 'none',
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        width: '100%',
        boxSizing: 'border-box',
        padding: '5px 2px',
        border: 0,
        borderBottom: `1px solid ${BORDER}`,
        background: 'transparent',
        color: 'inherit',
        font: 'inherit',
        textAlign: 'left',
        cursor: 'pointer',
      },
      dayDate: { flex: '0 0 auto', fontSize: FS.base, fontWeight: 600, color: LABEL1, fontVariantNumeric: 'tabular-nums' },
      // ── 时间轴视觉（2026-11-18）──
      // 它叫「时间轴」，之前却是个普通列表 —— 没有轴。现在是：
      //   11-18 ──────  425 条 / 10 场
      //   │
      //   ● 00:20–01:34   共 51 条
      //   ● 01:40–02:06   共 40 条
      // 竖线 + 节点就是「轴」，一眼看得出这是按时间排的。
      sceneList: {
        position: 'relative',
        paddingLeft: 14,
        marginLeft: 5,
      },
      sceneItem: { position: 'relative' },
      // 节点：钉在书签细线上的微光墨点
      sceneDot: {
        position: 'absolute',
        left: -17,
        top: 11,
        width: 7,
        height: 7,
        borderRadius: '50%',
        background: 'var(--dsw-alias-bg-base, var(--dsw-alias-card-fill, Canvas))',
        borderWidth: 1.5,
        borderStyle: 'solid',
        borderColor: `color-mix(in srgb, ${BRAND} 45%, transparent)`,
        boxSizing: 'border-box',
        pointerEvents: 'none',
      },
      // 展开中的那一场：青黛墨点 + 柔和晕圈
      sceneDotOn: {
        borderColor: BRAND,
        background: BRAND,
        boxShadow: `0 0 0 3px color-mix(in srgb, ${BRAND} 22%, transparent)`,
      },
      dayCaret: {
        flex: '0 0 auto',
        width: 10,
        fontSize: FS.xs,
        color: LABEL3,
        transition: 'transform .15s ease',
        transformOrigin: 'center',
      },
      dayDash: {
        flex: '1 1 auto',
        minWidth: 8,
        height: 0,
        borderTop: `1px dashed ${BORDER_STRONG}`,
        opacity: 0.7,
      },
      dayMeta: { flex: '0 0 auto', fontSize: FS.sm, color: LABEL3, fontVariantNumeric: 'tabular-nums' },
      sceneRow: {
        appearance: 'none',
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        width: '100%',
        boxSizing: 'border-box',
        padding: '6px 8px',
        border: 0,
        borderRadius: 10,
        background: 'transparent',
        color: LABEL2,
        font: 'inherit',
        fontSize: FS.sm,
        textAlign: 'left',
        cursor: 'pointer',
      },
      sceneTime: { flex: '1 1 auto', minWidth: 0, fontSize: FS.sm, fontWeight: 500, color: LABEL1, fontVariantNumeric: 'tabular-nums' },
      sceneMeta: { flex: '0 0 auto', color: LABEL3, fontVariantNumeric: 'tabular-nums' },
      tag: {
        flex: '0 0 auto',
        padding: '1px 6px',
        borderRadius: 999,
        border: `1px solid color-mix(in srgb, ${BRAND} 35%, ${BORDER})`,
        color: BRAND,
        fontSize: FS.xs,
        lineHeight: '14px',
      },
      msgRow: {
        padding: '10px 13px',
        borderWidth: 1,
        borderStyle: 'solid',
        borderColor: BORDER,
        borderRadius: 12,
        marginBottom: 8,
        boxShadow: '0 1px 2px rgba(0,0,0,.025)',
      },
      // 「前一场的尾巴」：背景补充，颜色压暗 + 虚线左边，和本场原文区分开（D-098 不做推断）
      leadInBox: {
        margin: '2px 0 6px',
        padding: '5px 8px',
        borderLeft: `2px dashed ${BORDER_STRONG}`,
        background: 'var(--dsw-alias-bg-layer-1, transparent)',
        borderRadius: RADIUS_SM,
      },
      leadInRow: { display: 'flex', gap: 6, alignItems: 'flex-start', padding: '2px 0' },
      leadInSpeaker: { flex: '0 0 auto', fontSize: FS.xs, color: LABEL3, fontWeight: 600, lineHeight: '20px' },
      leadInText: {
        flex: '1 1 auto',
        minWidth: 0,
        fontSize: FS.base,
        lineHeight: 1.5,
        color: LABEL2,
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
        maxHeight: 220,
        overflowY: 'auto',
        paddingRight: 4,
      },
      msgHead: { display: 'flex', alignItems: 'baseline', gap: 6, flexWrap: 'wrap' },
      msgTime: { fontSize: FS.xs, color: LABEL3, fontVariantNumeric: 'tabular-nums' },
      msgSpeaker: { fontSize: FS.sm, fontWeight: 600 },
      msgText: {
        marginTop: 2,
        fontSize: FS.base,
        lineHeight: 1.55,
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
        maxHeight: 220,
        overflowY: 'auto',
        paddingRight: 4,
      },
      /* ── Markdown 渲染样式 ── */
      mdRoot: { display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 },
      mdPara: { margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word' },
      mdH1: { fontSize: FS.md, fontWeight: 700, lineHeight: 1.4, margin: '2px 0 1px' },
      mdH2: { fontSize: FS.base, fontWeight: 700, lineHeight: 1.4, margin: '2px 0 1px' },
      mdH3: { fontSize: FS.base, fontWeight: 600, lineHeight: 1.4, margin: '1px 0' },
      mdInlineCode: {
        fontFamily: CODE_FONT,
        fontSize: '0.92em',
        padding: '0 4px',
        borderRadius: 3,
        background: 'var(--dsw-alias-bg-layer-2, rgba(128,128,128,.16))',
        wordBreak: 'break-all',
      },
      mdCodeWrap: {
        borderWidth: 1,
        borderStyle: 'solid',
        borderColor: BORDER,
        borderRadius: RADIUS_SM,
        background: 'var(--dsw-alias-bg-layer-1, rgba(128,128,128,.08))',
        overflow: 'hidden',
      },
      mdCodeLang: {
        fontSize: FS.xs,
        fontFamily: CODE_FONT,
        color: LABEL3,
        padding: '2px 7px',
        borderBottom: `1px solid ${BORDER}`,
      },
      mdPre: {
        margin: 0,
        padding: '6px 8px',
        fontFamily: CODE_FONT,
        fontSize: FS.xs,
        lineHeight: 1.45,
        overflowX: 'auto',
        whiteSpace: 'pre',
      },
      mdQuote: {
        margin: 0,
        padding: '2px 0 2px 8px',
        borderLeft: `2px solid ${BORDER_STRONG}`,
        color: LABEL2,
      },
      mdList: { margin: 0, paddingLeft: 16 },
      mdLi: { margin: '1px 0', wordBreak: 'break-word' },
      mdLink: { color: LINK, textDecoration: 'underline', wordBreak: 'break-all' },
      noteCard: {
        boxSizing: 'border-box',
        border: `1px solid ${BORDER}`,
        borderRadius: 12,
        padding: '10px 12px',
        marginTop: 8,
        background: 'var(--dsw-alias-card-fill, transparent)',
        boxShadow: '0 1px 3px rgba(0,0,0,.03)',
      },
      rowBetween: { display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8 },
      input: {
        boxSizing: 'border-box',
        flex: '1 1 auto',
        minWidth: 0,
        padding: '4px 7px',
        border: `1px solid ${BORDER_STRONG}`,
        borderRadius: RADIUS_SM,
        background: 'var(--dsw-alias-bg-layer-1, transparent)',
        color: LABEL1,
        font: 'inherit',
        fontSize: FS.base,
        lineHeight: '18px',
      },
      formRow: { display: 'flex', alignItems: 'center', gap: 6, marginTop: 6 },
      paneWrap: { display: 'grid', gridTemplateColumns: 'minmax(0,1fr) minmax(0,1fr)', gap: 8, marginTop: 6 },
      pane: {
        boxSizing: 'border-box',
        minWidth: 0,
        padding: '6px 7px',
        border: `1px solid ${BORDER}`,
        borderRadius: RADIUS_SM,
        background: 'var(--dsw-alias-bg-layer-1, transparent)',
        fontSize: FS.base,
        lineHeight: 1.55,
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
      },
      paneLabel: { fontSize: FS.xs, color: LABEL3, marginBottom: 2 },
      diffMark: {
        background: `color-mix(in srgb, ${ERROR} 20%, transparent)`,
        color: 'inherit',
        borderRadius: 2,
        padding: '0 1px',
      },
      flashOk: {
        marginBottom: 8,
        padding: '5px 8px',
        borderRadius: RADIUS_SM,
        border: `1px solid color-mix(in srgb, ${SUCCESS} 45%, transparent)`,
        background: `color-mix(in srgb, ${SUCCESS} 10%, transparent)`,
        color: SUCCESS,
        fontSize: FS.sm,
        lineHeight: 1.5,
        wordBreak: 'break-word',
      },
      flashErr: {
        marginBottom: 8,
        padding: '5px 8px',
        borderRadius: RADIUS_SM,
        border: `1px solid color-mix(in srgb, ${ERROR} 45%, transparent)`,
        background: `color-mix(in srgb, ${ERROR} 10%, transparent)`,
        color: ERROR,
        fontSize: FS.sm,
        lineHeight: 1.5,
        wordBreak: 'break-word',
      },
      // 「写成功但状态没确认」：既不能说成功，也不能说失败
      flashWarn: {
        marginBottom: 8,
        padding: '5px 8px',
        borderRadius: RADIUS_SM,
        border: `1px solid ${WARN_BORDER}`,
        background: `color-mix(in srgb, ${WARN} 10%, transparent)`,
        color: WARN,
        fontSize: FS.sm,
        lineHeight: 1.5,
        wordBreak: 'break-word',
      },
      flagCard: {
        boxSizing: 'border-box',
        border: `1px solid ${BORDER}`,
        borderRadius: RADIUS_SM,
        padding: '7px 9px',
        marginTop: 6,
      },
      snippet: { fontSize: FS.base, lineHeight: 1.5, whiteSpace: 'pre-wrap', wordBreak: 'break-word' },
      actions: { display: 'flex', gap: 8, alignItems: 'center', marginTop: 6, flexWrap: 'wrap' },
      /* ── 搜索页 & 通用交互组件样式 ── */
      searchBar: {
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        marginBottom: 8,
      },
      searchInputWrap: {
        position: 'relative',
        flex: '1 1 auto',
        minWidth: 0,
        display: 'flex',
        alignItems: 'center',
        border: `1px solid ${BORDER_STRONG}`,
        borderRadius: 999,
        background: 'var(--dsw-alias-bg-layer-1, transparent)',
        boxShadow: '0 1px 4px rgba(0,0,0,.04)',
        padding: '2px 10px 2px 12px',
        transition: T,
      },
      searchIcon: {
        flex: '0 0 auto',
        color: LABEL3,
        marginRight: 6,
        display: 'flex',
        alignItems: 'center',
      },
      searchInput: {
        boxSizing: 'border-box',
        flex: '1 1 auto',
        minWidth: 0,
        border: 0,
        outline: 'none',
        background: 'transparent',
        color: LABEL1,
        font: 'inherit',
        fontSize: FS.base,
        lineHeight: '20px',
        padding: '4px 0',
      },
      clearBtn: {
        appearance: 'none',
        flex: '0 0 auto',
        border: 0,
        background: 'transparent',
        color: LABEL3,
        fontSize: FS.md,
        lineHeight: 1,
        padding: '2px 4px',
        cursor: 'pointer',
        borderRadius: RADIUS_SM,
      },
      pillRow: {
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 6,
        flexWrap: 'wrap',
        marginBottom: 8,
      },
      pillGroup: {
        display: 'flex',
        alignItems: 'center',
        gap: 4,
        flexWrap: 'wrap',
      },
      pill: {
        appearance: 'none',
        padding: '3px 10px',
        borderRadius: 999,
        borderWidth: 1,
        borderStyle: 'solid',
        borderColor: BORDER,
        background: 'transparent',
        color: LABEL2,
        font: 'inherit',
        fontSize: FS.xs,
        fontWeight: 500,
        lineHeight: '16px',
        cursor: 'pointer',
        whiteSpace: 'nowrap',
      },
      pillActive: {
        borderColor: BRAND,
        background: `color-mix(in srgb, ${BRAND} 13%, transparent)`,
        color: BRAND,
        fontWeight: 600,
      },
      checkLabel: {
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        fontSize: FS.xs,
        color: LABEL2,
        cursor: 'pointer',
        userSelect: 'none',
      },
      searchSummary: {
        display: 'flex',
        alignItems: 'baseline',
        justifyContent: 'space-between',
        gap: 8,
        marginBottom: 6,
        fontSize: FS.sm,
        color: LABEL3,
      },
      searchCard: {
        boxSizing: 'border-box',
        border: `1px solid ${BORDER}`,
        borderLeftWidth: 3,
        borderRadius: RADIUS,
        padding: '8px 10px',
        marginTop: 8,
        background: 'var(--dsw-alias-card-fill, transparent)',
      },
      searchMetaRow: {
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 6,
      },
      searchMetaLeft: {
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        flexWrap: 'wrap',
        minWidth: 0,
      },
      sourceBadgeKw: {
        padding: '0 5px',
        borderRadius: 999,
        border: `1px solid ${BORDER_STRONG}`,
        color: LABEL2,
        fontSize: FS.xs,
        lineHeight: '15px',
        whiteSpace: 'nowrap',
      },
      sourceBadgeVec: {
        padding: '0 5px',
        borderRadius: 999,
        border: `1px solid color-mix(in srgb, ${BRAND} 45%, transparent)`,
        background: `color-mix(in srgb, ${BRAND} 10%, transparent)`,
        color: BRAND,
        fontSize: FS.xs,
        lineHeight: '15px',
        whiteSpace: 'nowrap',
      },
      sourceBadgeBoth: {
        padding: '0 5px',
        borderRadius: 999,
        border: `1px solid color-mix(in srgb, ${SUCCESS} 45%, transparent)`,
        background: `color-mix(in srgb, ${SUCCESS} 10%, transparent)`,
        color: SUCCESS,
        fontSize: FS.xs,
        lineHeight: '15px',
        whiteSpace: 'nowrap',
      },
      searchMark: {
        background: `color-mix(in srgb, ${WARN} 28%, transparent)`,
        color: 'inherit',
        borderRadius: 2,
        padding: '0 1px',
      },
      chunkBar: {
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        flexWrap: 'wrap',
        marginTop: 4,
        fontSize: FS.xs,
        color: LABEL3,
      },
      copyBtn: {
        appearance: 'none',
        flex: '0 0 auto',
        padding: '1px 6px',
        borderWidth: 1,
        borderStyle: 'solid',
        borderColor: BORDER,
        borderRadius: RADIUS_SM,
        background: 'transparent',
        color: LABEL3,
        font: 'inherit',
        fontSize: FS.xs,
        lineHeight: '15px',
        cursor: 'pointer',
        whiteSpace: 'nowrap',
      },
      copyBtnDone: {
        borderColor: `color-mix(in srgb, ${SUCCESS} 50%, transparent)`,
        color: SUCCESS,
      },
      searchFooter: {
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 8,
        marginTop: 6,
        flexWrap: 'wrap',
      },
      searchEntryBtn: {
        appearance: 'none',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 8,
        width: '100%',
        boxSizing: 'border-box',
        padding: '8px 13px',
        borderWidth: 1,
        borderStyle: 'solid',
        borderColor: BORDER,
        borderRadius: 999,
        background: 'var(--dsw-alias-bg-layer-1, transparent)',
        color: LABEL3,
        font: 'inherit',
        fontSize: FS.sm,
        cursor: 'pointer',
        textAlign: 'left',
      },
      /* ── 笔记分段开关 & 回收站 ── */
      segmented: {
        display: 'inline-flex',
        border: `1px solid ${BORDER_STRONG}`,
        borderRadius: RADIUS_SM,
        overflow: 'hidden',
        marginBottom: 8,
      },
      segBtn: {
        appearance: 'none',
        padding: '4px 10px',
        border: 0,
        background: 'transparent',
        color: LABEL2,
        font: 'inherit',
        fontSize: FS.sm,
        fontWeight: 400,
        lineHeight: '18px',
        cursor: 'pointer',
        whiteSpace: 'nowrap',
      },
      /* ── 数据库管理台 ── */
      dbSelect: {
        boxSizing: 'border-box',
        width: '100%',
        padding: '4px 7px',
        border: `1px solid ${BORDER_STRONG}`,
        borderRadius: RADIUS_SM,
        background: 'var(--dsw-alias-bg-layer-1, transparent)',
        color: LABEL1,
        font: 'inherit',
        fontSize: FS.sm,
        lineHeight: '18px',
      },
      dbChipRow: {
        display: 'flex',
        gap: 4,
        flexWrap: 'wrap',
        marginTop: 6,
      },
      dbChip: {
        appearance: 'none',
        padding: '2px 7px',
        borderRadius: 999,
        borderWidth: 1,
        borderStyle: 'solid',
        borderColor: BORDER,
        background: 'transparent',
        color: LABEL2,
        font: 'inherit',
        fontSize: FS.xs,
        fontWeight: 400,
        lineHeight: '16px',
        cursor: 'pointer',
      },
      dbChipOn: {
        borderColor: BRAND,
        background: `color-mix(in srgb, ${BRAND} 12%, transparent)`,
        color: BRAND,
        fontWeight: 600,
      },
      dbRowCard: {
        boxSizing: 'border-box',
        border: `1px solid ${BORDER}`,
        borderRadius: RADIUS_SM,
        padding: '6px 8px',
        marginTop: 6,
        background: 'var(--dsw-alias-card-fill, transparent)',
      },
      dbDetailPre: {
        margin: '6px 0 0',
        padding: '6px 7px',
        borderRadius: RADIUS_SM,
        border: `1px solid ${BORDER}`,
        background: 'var(--dsw-alias-bg-layer-1, transparent)',
        fontFamily: CODE_FONT,
        fontSize: FS.xs,
        lineHeight: 1.45,
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-all',
      },
      dbSqlArea: {
        boxSizing: 'border-box',
        width: '100%',
        minHeight: 74,
        padding: '6px 8px',
        border: `1px solid ${BORDER_STRONG}`,
        borderRadius: RADIUS_SM,
        background: 'var(--dsw-alias-bg-layer-1, transparent)',
        color: LABEL1,
        fontFamily: CODE_FONT,
        fontSize: FS.xs,
        lineHeight: 1.5,
        resize: 'vertical',
      },
      dbTableWrap: {
        marginTop: 8,
        border: `1px solid ${BORDER}`,
        borderRadius: RADIUS_SM,
        overflowX: 'auto',
        maxHeight: 280,
        overflowY: 'auto',
      },
      dbTable: {
        width: '100%',
        borderCollapse: 'collapse',
        fontSize: FS.xs,
        fontFamily: CODE_FONT,
      },
      dbTh: {
        textAlign: 'left',
        padding: '4px 6px',
        borderBottom: `1px solid ${BORDER_STRONG}`,
        background: 'var(--dsw-alias-bg-layer-1, transparent)',
        color: LABEL2,
        whiteSpace: 'nowrap',
        position: 'sticky',
        top: 0,
      },
      dbTd: {
        padding: '4px 6px',
        borderBottom: `1px solid ${BORDER}`,
        color: LABEL1,
        verticalAlign: 'top',
        maxWidth: 220,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
      },
      segBtnActive: {
        background: `color-mix(in srgb, ${BRAND} 14%, transparent)`,
        color: BRAND,
        fontWeight: 600,
      },
      trashMeta: {
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        flexWrap: 'wrap',
        fontSize: FS.xs,
        color: LABEL3,
      },
      /* ── 隐私排除时段 ── */
      excludeCard: {
        boxSizing: 'border-box',
        border: `1px solid ${BORDER}`,
        borderRadius: RADIUS,
        background: 'var(--dsw-alias-card-fill, transparent)',
        padding: '8px 10px',
      },
      excludeItem: {
        display: 'flex',
        alignItems: 'flex-start',
        justifyContent: 'space-between',
        gap: 8,
        padding: '5px 0',
        borderBottom: `1px solid ${BORDER}`,
      },
      excludeRangeText: {
        fontFamily: CODE_FONT,
        fontSize: FS.sm,
        color: LABEL1,
      },
      excludeForm: {
        marginTop: 8,
        paddingTop: 8,
        borderTop: `1px dashed ${BORDER_STRONG}`,
      },
      dateGrid: {
        display: 'grid',
        gridTemplateColumns: 'minmax(0,1fr) minmax(0,1fr)',
        gap: 6,
        marginTop: 4,
      },
      fieldLabel: {
        fontSize: FS.xs,
        color: LABEL3,
        marginBottom: 2,
      },
      /* ── 骨架屏 ── */
      skeletonCard: {
        boxSizing: 'border-box',
        border: `1px solid ${BORDER}`,
        borderRadius: RADIUS,
        padding: '10px 10px',
        marginTop: 8,
      },
      skeletonBar: {
        height: 10,
        borderRadius: 4,
      },
    };

    /* ══════════════════════════ 小部件 ══════════════════════════ */

    function Glyph({ size = 18 }) {
      return h('svg', {
        viewBox: '0 0 24 24',
        width: size,
        height: size,
        'aria-hidden': true,
        style: { display: 'block', flex: '0 0 auto' },
      },
        h('rect', { x: 3, y: 4, width: 18, height: 16, rx: 3, fill: 'currentColor', opacity: 0.2 }),
        h('rect', { x: 6, y: 8, width: 12, height: 1.8, rx: 0.9, fill: 'currentColor' }),
        h('rect', { x: 6, y: 11.5, width: 9, height: 1.8, rx: 0.9, fill: 'currentColor', opacity: 0.72 }),
        h('rect', { x: 6, y: 15, width: 11, height: 1.8, rx: 0.9, fill: 'currentColor', opacity: 0.5 }),
      );
    }

    function SearchIcon({ size = 14 }) {
      return h('svg', {
        viewBox: '0 0 24 24',
        width: size,
        height: size,
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 2,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': true,
        style: { display: 'block', flex: '0 0 auto' },
      },
        h('circle', { cx: 11, cy: 11, r: 7 }),
        h('line', { x1: 20, y1: 20, x2: 16.5, y2: 16.5 }),
      );
    }

    function SparkIcon({ size = 13 }) {
      return h('svg', {
        viewBox: '0 0 24 24',
        width: size,
        height: size,
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 2,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': true,
        style: { display: 'block', flex: '0 0 auto' },
      },
        h('path', { d: 'M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9L12 3z' }),
      );
    }

    function MomentIcon({ size = 13 }) {
      return h('svg', {
        viewBox: '0 0 24 24',
        width: size,
        height: size,
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 2,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': true,
        style: { display: 'block', flex: '0 0 auto' },
      },
        h('circle', { cx: 12, cy: 12, r: 9 }),
        h('polyline', { points: '12 7 12 12 15 14' }),
      );
    }

    function NoteIcon({ size = 13 }) {
      return h('svg', {
        viewBox: '0 0 24 24',
        width: size,
        height: size,
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 2,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': true,
        style: { display: 'block', flex: '0 0 auto' },
      },
        h('path', { d: 'M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z' }),
      );
    }

    function RefreshIcon({ size = 13 }) {
      return h('svg', {
        viewBox: '0 0 24 24',
        width: size,
        height: size,
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 2,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': true,
        style: { display: 'block', flex: '0 0 auto' },
      },
        h('polyline', { points: '23 4 23 10 17 10' }),
        h('path', { d: 'M20.49 15a9 9 0 1 1-2.12-9.36L23 10' }),
      );
    }

    function MicIcon({ size = 14 }) {
      return h('svg', {
        viewBox: '0 0 24 24',
        width: size,
        height: size,
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 2,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': true,
        style: { display: 'block', flex: '0 0 auto' },
      },
        h('path', { d: 'M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z' }),
      );
    }

    function BrainIcon({ size = 14 }) {
      return h('svg', {
        viewBox: '0 0 24 24',
        width: size,
        height: size,
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 2,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': true,
        style: { display: 'block', flex: '0 0 auto' },
      },
        h('path', { d: 'M12 2a7 7 0 0 1 7 7c0 2.5-1.3 4.7-3.3 5.9L15 18H9l-.7-3.1A7 7 0 0 1 12 2z' }),
        h('line', { x1: 9.5, y1: 21, x2: 14.5, y2: 21 }),
      );
    }

    function RingProgress({ pct = 0, size = 38, stroke = 3.5, color = BRAND }) {
      const clamped = Math.max(0, Math.min(100, Number(pct) || 0));
      const r = (size - stroke) / 2;
      const c = 2 * Math.PI * r;
      const offset = c * (1 - clamped / 100);
      return h('div', {
        style: {
          position: 'relative',
          width: size,
          height: size,
          flex: '0 0 auto',
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
        },
      },
        h('svg', {
          width: size,
          height: size,
          viewBox: `0 0 ${size} ${size}`,
          style: { transform: 'rotate(-90deg)', display: 'block' },
          'aria-hidden': true,
        },
          h('circle', {
            cx: size / 2,
            cy: size / 2,
            r,
            fill: 'none',
            stroke: 'var(--dsw-alias-bg-layer-2, rgba(128,128,128,.2))',
            strokeWidth: stroke,
          }),
          h('circle', {
            cx: size / 2,
            cy: size / 2,
            r,
            fill: 'none',
            stroke: color,
            strokeWidth: stroke,
            strokeLinecap: 'round',
            strokeDasharray: c,
            strokeDashoffset: offset,
            style: { transition: 'stroke-dashoffset .4s ease, stroke .2s ease' },
          })),
        h('span', {
          style: {
            position: 'absolute',
            fontSize: 9.5,
            fontWeight: 600,
            color: LABEL1,
            fontVariantNumeric: 'tabular-nums',
          },
        }, `${clamped}%`));
    }

    function SanctuaryArt() {
      return h('svg', {
        viewBox: '0 0 120 80',
        width: 96,
        height: 64,
        'aria-hidden': true,
        style: {
          position: 'absolute',
          right: -6,
          top: -4,
          opacity: 0.16,
          pointerEvents: 'none',
        },
      },
        h('circle', { cx: 88, cy: 26, r: 22, fill: BRAND }),
        h('circle', { cx: 64, cy: 48, r: 14, fill: '#e07a96' }),
        h('path', {
          d: 'M88 10l2.8 7.2L98 20l-7.2 2.8L88 30l-2.8-7.2L78 20l7.2-2.8z',
          fill: '#fff',
        }),
      );
    }

    function SkeletonGroup({ kind = 'cards', count = 3 }) {
      if (kind === 'rows') {
        return h('div', { 'aria-hidden': true },
          ...Array.from({ length: count }, (_, i) => h('div', {
            key: `sk-r-${i}`,
            style: { display: 'flex', alignItems: 'center', gap: 8, padding: '8px 2px', borderBottom: `1px solid ${BORDER}` },
          },
            h('div', { className: 'dvp-shimmer', style: { ...S.skeletonBar, width: 42 } }),
            h('div', { className: 'dvp-shimmer', style: { ...S.skeletonBar, flex: '1 1 auto', height: 6 } }),
            h('div', { className: 'dvp-shimmer', style: { ...S.skeletonBar, width: 78 } }))));
      }
      if (kind === 'lines') {
        return h('div', { 'aria-hidden': true, style: { padding: '4px 0 6px' } },
          ...Array.from({ length: count }, (_, i) => h('div', {
            key: `sk-l-${i}`,
            style: { padding: '5px 0 5px 8px', borderLeft: `2px solid ${BORDER}`, marginBottom: 4 },
          },
            h('div', { className: 'dvp-shimmer', style: { ...S.skeletonBar, width: '32%', height: 8 } }),
            h('div', { className: 'dvp-shimmer', style: { ...S.skeletonBar, width: i % 2 === 0 ? '88%' : '72%', marginTop: 6 } }))));
      }
      return h('div', { 'aria-hidden': true },
        ...Array.from({ length: count }, (_, i) => h('div', { key: `sk-c-${i}`, style: S.skeletonCard },
          h('div', { className: 'dvp-shimmer', style: { ...S.skeletonBar, width: '44%', height: 9 } }),
          h('div', { className: 'dvp-shimmer', style: { ...S.skeletonBar, width: '92%', marginTop: 8 } }),
          h('div', { className: 'dvp-shimmer', style: { ...S.skeletonBar, width: i % 2 === 0 ? '68%' : '78%', marginTop: 6 } }))));
    }

    /** 开关：只有「开 / 关」两态，没有第三态（D-166 / B2） */
    function Switch({ checked, disabled, label, onChange }) {
      return h('button', {
        type: 'button',
        role: 'switch',
        'aria-checked': checked === true,
        'aria-label': label,
        title: label,
        disabled: disabled === true,
        onClick: () => {
          if (!disabled) onChange(!checked);
        },
        style: {
          appearance: 'none',
          position: 'relative',
          flex: '0 0 auto',
          width: 34,
          height: 20,
          padding: 0,
          border: `1px solid ${checked ? 'transparent' : BORDER_STRONG}`,
          borderRadius: 999,
          background: checked ? BRAND : 'var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.22))',
          cursor: disabled ? 'default' : 'pointer',
          opacity: disabled ? 0.6 : 1,
          transition: 'background-color 120ms ease',
        },
      }, h('span', {
        style: {
          position: 'absolute',
          top: 2,
          left: checked ? 16 : 2,
          width: 14,
          height: 14,
          borderRadius: '50%',
          background: 'var(--dsw-alias-switch-thumb, #fff)',
          boxShadow: '0 1px 2px rgba(0,0,0,.28)',
          transition: 'left 120ms ease',
        },
      }));
    }

    /** 会话名（PANEL §2 标题里的「当前对话名」）。拿不到就不占位。 */
    function SessionTitle({ useSessions, sessionId }) {
      const name = useSessions((snapshot) => {
        const record = snapshot && snapshot.byId ? snapshot.byId[sessionId] : undefined;
        if (!record) return null;
        return record.displayTitle ?? record.title ?? record.name ?? null;
      });
      if (typeof name !== 'string' || name === '') return null;
      return h('div', { style: S.sessionName, title: name }, name);
    }

    const noopSessionHook = () => null;

    /** 内联会话名（用于库管理里的跨会话列表，优先展示真实标题，兜底短 sessionId） */
    function SessionInlineName({ useSessions, sessionId }) {
      const hook = typeof useSessions === 'function' ? useSessions : noopSessionHook;
      const name = hook((snapshot) => {
        const record = snapshot && snapshot.byId ? snapshot.byId[sessionId] : undefined;
        if (!record) return null;
        return record.displayTitle ?? record.title ?? record.name ?? null;
      });
      const label = typeof name === 'string' && name.trim() ? name.trim() : shortSid(sessionId);
      return h('span', { title: `${label} (${sessionId})` }, label);
    }

    /** 分栏显示一段原文；从第一个差异处开始标红 */
    function TextPane({ label, text, markAt }) {
      const value = typeof text === 'string' ? text : '';
      return h('div', { style: { minWidth: 0 } },
        h('div', { style: S.paneLabel }, label),
        h('div', { style: S.pane },
          markAt >= 0 && markAt < value.length
            ? [
              h('span', { key: 'same' }, value.slice(0, markAt)),
              h('mark', { key: 'diff', style: S.diffMark }, value.slice(markAt)),
            ]
            : value === ''
              ? h('span', { style: S.dim }, '—')
              : value));
    }

