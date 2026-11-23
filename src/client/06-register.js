        ctx.effect(() => ctx.locale.register(NS, { en, zh }), 'dsh-verbatim: dictionaries');

        // ② 交互态样式表（2026-11-18）
        //
        // React 内联样式写不了 :hover / :focus-visible，而"按钮点上去没反应"
        // 是 UX 优先级最高的一类问题。所以注入一小段全局 CSS，只作用于
        // [data-dsh-verbatim] 子树 —— 不会漏到宿主页面其他地方。
        //
        // 覆盖：hover、focus-visible（键盘可达）、active、disabled、
        //      以及 prefers-reduced-motion（系统开了减少动效就全关掉）。
        ctx.effect(() => injectStyle(`dsh-verbatim-interaction`, `
          @keyframes dvp-run {
            0% { transform: translateX(-100%); }
            50% { transform: translateX(120%); }
            100% { transform: translateX(300%); }
          }
          @keyframes dvp-shimmer {
            0% { opacity: .45; }
            50% { opacity: .85; }
            100% { opacity: .45; }
          }
          @keyframes dvp-fade {
            from { opacity: 0; }
            to { opacity: 1; }
          }
          @keyframes dvp-slide {
            from { opacity: 0; transform: translateY(4px); }
            to { opacity: 1; transform: translateY(0); }
          }
          @keyframes dvp-pulse {
            0%, 100% { opacity: 1; transform: scale(1); }
            50% { opacity: .55; transform: scale(0.88); }
          }
          [data-dsh-verbatim] .dvp-fade { animation: dvp-fade .18s ease-out both; }
          [data-dsh-verbatim] .dvp-slide { animation: dvp-slide .22s ease-out both; }
          [data-dsh-verbatim] .dvp-dot-live { animation: dvp-pulse 2.4s ease-in-out infinite; }
          [data-dsh-verbatim] .dvp-card {
            transition: transform .16s ease, border-color .16s ease, box-shadow .16s ease;
          }
          [data-dsh-verbatim] .dvp-card:hover {
            border-color: var(--dsw-alias-border-l3, rgba(128,128,128,.4)) !important;
            box-shadow: 0 3px 10px rgba(0,0,0,.05) !important;
          }
          [data-dsh-verbatim] .dvp-kpi:hover {
            transform: translateY(-1px);
          }
          [data-dsh-verbatim] .dvp-search-wrap:focus-within {
            border-color: var(--dsw-alias-state-business-primary, #4d6bfe) !important;
            box-shadow: 0 0 0 3px color-mix(in srgb, var(--dsw-alias-state-business-primary, #4d6bfe) 14%, transparent) !important;
          }
          [data-dsh-verbatim] .dvp-msg-card .dvp-msg-actions {
            opacity: 0.45;
            transition: opacity .15s ease;
          }
          [data-dsh-verbatim] .dvp-msg-card:hover .dvp-msg-actions,
          [data-dsh-verbatim] .dvp-msg-card:focus-within .dvp-msg-actions {
            opacity: 1;
          }
          [data-dsh-verbatim] .dvp-shimmer {
            background: var(--dsw-alias-bg-l2, rgba(128,128,128,.16));
            animation: dvp-shimmer 1.3s ease-in-out infinite;
          }
          [data-dsh-verbatim] button { transition: ${T}; }
          [data-dsh-verbatim] button:focus:not(:focus-visible) { outline: none; }
          [data-dsh-verbatim] button:hover:not(:disabled) { opacity: 0.86; }
          [data-dsh-verbatim] button:active:not(:disabled) { transform: translateY(0.5px); }
          [data-dsh-verbatim] button:focus-visible {
            outline: 2px solid var(--dsw-alias-state-business-primary, #4d6bfe);
            outline-offset: 2px;
          }
          [data-dsh-verbatim] button:disabled {
            opacity: .5;
            cursor: default;
            filter: none;
            transform: none;
          }
          /* 键盘焦点在输入框上也要看得见 */
          [data-dsh-verbatim] input:focus-visible {
            outline: 2px solid var(--dsw-alias-state-business-primary, #4d6bfe);
            outline-offset: 1px;
          }
          /* 可点的整行/卡片：有 hover 才让人知道能点 */
          [data-dsh-verbatim] [data-clickable="1"] { transition: ${T}; cursor: pointer; }
          [data-dsh-verbatim] [data-clickable="1"]:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.07)); }
          [data-dsh-verbatim] [data-clickable="1"]:focus-visible {
            outline: 2px solid var(--dsw-alias-state-business-primary, #4d6bfe);
            outline-offset: -2px;
          }
          /* 滚动条：细一点，别抢戏 */
          [data-dsh-verbatim] ::-webkit-scrollbar { width: 8px; height: 8px; }
          [data-dsh-verbatim] ::-webkit-scrollbar-thumb {
            background: var(--dsw-alias-border-l3, rgba(128,128,128,.32));
            border-radius: 4px;
          }
          [data-dsh-verbatim] ::-webkit-scrollbar-track { background: transparent; }

          @media (prefers-reduced-motion: reduce) {
            [data-dsh-verbatim] * {
              transition-duration: 0.01ms !important;
              animation-duration: 0.01ms !important;
            }
            [data-dsh-verbatim] button:active:not(:disabled) { transform: none; }
          }
        `), 'dsh-verbatim: interaction css');

        // ① 面板类型（决定它出现在「开始」页的工具列表里，也决定 tab 标题）
        ctx.effect(() => ctx.sidebarRightTabs.register({
          id: TAB_ID,
          kind: TAB_KIND,
          title: () => t('title'),
          keepMounted: true,
          guide: [{
            id: 'verbatim',
            order: 40,
            title: () => t('title'),
            description: () => t('description'),
            icon: (iconProps) => h(Glyph, { size: (iconProps && iconProps.size) || 22 }),
          }],
        }), 'dsh-verbatim: tab type');

        // ② 面板正文：session 作用域，inject 拿到的第一个参数就是 sessionId
        ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
          name: 'sidebar.right.pane.tab',
          key: TAB_ID,
          locale: NS,
          inject: (sessionId) => ({ sessionId }),
        }, PanelSeat)), 'dsh-verbatim: tab body');

        // ③ tab 条上的标题（带图标，语言切换时会重新渲染）
        ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab.title', () => ctx.slots.register({
          name: 'sidebar.right.pane.tab.title',
          key: TAB_ID,
          locale: NS,
        }, TabTitle)), 'dsh-verbatim: tab title');

        // ④ 设置页：全局配置（默认开关 + 模型 + 检索参数）
        //    不放在右侧面板里，因为它是**全局**的，不属于任何一个对话。
        ctx.effect(() => ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'verbatim',
          order: 900,
          label: () => t('settings.nav'),
          locale: NS,
        }, (props) => h(SettingsPanel, { ...props, t: (props && props.t) || t }))), 'dsh-verbatim: settings section');
      },
    };
  },
});
