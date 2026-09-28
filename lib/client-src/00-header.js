// dsh-key-rotation — Settings card (Key Rotation).
// Renders in Settings → Plugins → Plugin settings via the settings.plugin.item slot and
// edits the plugin's `dsh-key-rotation` settings namespace through the
// loopback-fenced config bridge at /dsh-key-rotation/config.
//
// The config is a KEY POOL PER PROVIDER: a list of providers, each with a list
// of API-key env names. The provider is picked from the catalog of providers
// actually registered with ctx.llm (served by the host as data.providers), so no
// manual route typing is ever needed. The plugin derives the fallback chain and
// auto-creates clone routes from the key count.
//
// Localization: source strings are English; Chinese is a first-class locale (en + zh).
// Other languages come from the DSH core locale service / translation plugins
// via props.t (slot locale: NS). Active locale prefers ctx.locale.getSnapshot().active,
// else first navigator.languages entry, else 'en' — same fallback chain as DSH core.
window.__ModuleLoader__.load({
  id: '@goodandready/dsh-key-rotation',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    const React = require('react');
    const h = React.createElement;

        // Core primitives and chevron icon
    let ChevronIcon = null;
    try {
      const primitives = require('@deepseek-ai/dsh-client-primitives') || require('@deepseek-ai/dsh-client-icons');
      ChevronIcon = primitives && (primitives.IconChevronDownOutline14 || primitives.IconChevronDownOutline);
    } catch (err) {
      ChevronIcon = null;
    }

    const CONFIG_PATH = '/dsh-key-rotation/config';
    const NS = 'dsh-key-rotation';
    // Plugins page row seat (DSH 0.1.6-alpha.2): key = '<package name>#<row id>'.
    const PKG = '@goodandready/dsh-key-rotation';
    const ROW_ID = 'dsh-key-rotation';
    const ROW_CONFIG_KEY = PKG + '#' + ROW_ID;

    // -------------------------------------------------------------- i18n
