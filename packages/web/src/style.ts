/** The one stylesheet, served at /style.css (the CSP allows no inline styles). */
export const STYLESHEET = `
:root {
  --fg: #1f2328; --muted: #59636e; --bg: #fbfaf7; --card: #ffffff; --line: #e4e0d8;
  --accent: #6b3e26; --accent-fg: #ffffff; --error-bg: #fdecea; --error: #8a1c12; --ok-bg: #eaf5ea; --ok: #1d5b24;
  color-scheme: light;
}
* { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body {
  margin: 0; background: var(--bg); color: var(--fg);
  font: 16px/1.55 system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
}
a { color: var(--accent); }
a:focus-visible, button:focus-visible, input:focus-visible { outline: 3px solid #d9a441; outline-offset: 2px; }
.skip { position: absolute; left: -999px; }
.skip:focus { left: 1rem; top: 1rem; background: var(--card); padding: .5rem; }
header.site { border-bottom: 1px solid var(--line); background: var(--card); }
header.site .inner, main, footer.site { max-width: 44rem; margin: 0 auto; padding: 0 1rem; }
header.site .inner { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: .5rem; padding-top: .75rem; padding-bottom: .75rem; }
.brand { font-family: Georgia, "Times New Roman", serif; font-size: 1.4rem; font-weight: 700; color: var(--fg); text-decoration: none; }
nav ul { list-style: none; display: flex; flex-wrap: wrap; align-items: center; gap: .25rem 1rem; margin: 0; padding: 0; }
nav form { margin: 0; }
main { padding-top: 1.5rem; padding-bottom: 2rem; }
h1 { font-family: Georgia, "Times New Roman", serif; font-weight: 700; line-height: 1.2; font-size: 1.75rem; margin: 0 0 1rem; }
h2 { font-size: 1.15rem; margin: 1.75rem 0 .5rem; }
.lead { color: var(--muted); margin-top: 0; }
.stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(9rem, 1fr)); gap: .75rem; margin: 0; }
.stats div { background: var(--card); border: 1px solid var(--line); border-radius: 8px; padding: .75rem; }
.stats dt { color: var(--muted); font-size: .85rem; }
.stats dd { margin: 0; font-size: 1.5rem; font-weight: 600; font-variant-numeric: tabular-nums; }
table { border-collapse: collapse; width: 100%; background: var(--card); }
th, td { text-align: left; padding: .4rem .6rem; border-bottom: 1px solid var(--line); }
td.num { text-align: right; font-variant-numeric: tabular-nums; }
.card { background: var(--card); border: 1px solid var(--line); border-radius: 8px; padding: 1rem; }
form.stack { display: grid; gap: .9rem; max-width: 26rem; }
label { display: block; font-weight: 600; margin-bottom: .2rem; }
.hint { display: block; color: var(--muted); font-size: .85rem; font-weight: 400; }
input[type=email], input[type=password], input[type=text] {
  width: 100%; font: inherit; padding: .55rem .6rem; border: 1px solid #b9b3a8; border-radius: 6px; background: #fff;
}
button { font: inherit; cursor: pointer; border-radius: 6px; padding: .55rem 1rem; border: 1px solid var(--accent); background: var(--accent); color: var(--accent-fg); }
button.link { background: none; border: none; color: var(--accent); padding: 0; text-decoration: underline; }
.msg { border-radius: 6px; padding: .6rem .8rem; margin: 0 0 1rem; }
.msg.error { background: var(--error-bg); color: var(--error); }
.msg.ok { background: var(--ok-bg); color: var(--ok); }
dl.facts { display: grid; grid-template-columns: max-content 1fr; gap: .3rem 1rem; }
dl.facts dt { color: var(--muted); }
dl.facts dd { margin: 0; overflow-wrap: anywhere; }
code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: .9em; }
footer.site { color: var(--muted); font-size: .85rem; padding-bottom: 2rem; }
`;
