# Lynx Development Guide: Key Differences from the Web

> Goal: provide a “read this before writing code” entry point for current work in this repo, so we do not blindly apply Web/React instincts to Lynx.

## 1. What Lynx / ReactLynx is

- Lynx is a cross-platform rendering framework.
- ReactLynx is Lynx’s official React-like framework, allowing you to build Lynx pages with JSX and a React component mental model.
- Official docs make it clear that ReactLynx is based on a **React 17-compatible model**, not React 18/19 concurrent behavior.

This project uses a custom container layer that provides multi-page navigation, JS ↔ Native bridge, and native service integration directly via Lynx SDK APIs (`LynxModule`/`LynxContextModule`).

---

## 2. The most important mental model: Lynx is not the browser DOM

If you remember only one thing, remember this:

> **Lynx feels React-like to develop in, but its runtime model is not the Web.**

Common mistakes:

- assuming a JSX component only executes once
- assuming all JS APIs can be called the same way as in a browser
- assuming `overflow: scroll`, DOM events, HTML tags, and CSS inheritance all transfer directly
- assuming in-app navigation, storage, and media flows should use browser APIs first

In Lynx, those assumptions are either false or only partially true.

---

## 3. Lynx’s thread model: this is where the performance benefits come from, and where many constraints come from too

Besides the ReactLynx docs, Lynx also has dedicated `JavaScript Runtime` / `Scripting Runtime` documentation, which treats thread placement and runtime boundaries as first-class concepts rather than implementation details.

## 3.1 Dual-thread runtime

Official docs explain that ReactLynx runs on **two threads: main thread + background thread**:

- **main thread**: responsible for first-screen rendering and applying subsequent UI updates
- **background thread**: runs the full React runtime, including component lifecycle work, side effects, and state updates

This is fundamentally different from single-threaded Web React.

## 3.2 Why a component may appear to execute twice

Official examples explicitly show that code like this:

```tsx
const HelloComponent = () => {
  console.log('Hello')
  return <text>Hello</text>
}
```

may log twice because the rendering flow involves two threads.

### What this means in practice

- **Do not treat render as a place that executes only once**
- **Do not put side effects in render**
- **Do not register global events / call native modules / fetch data / write storage in render**

Those operations should live in effects, lifecycle-appropriate places, or explicitly thread-safe mechanisms.

## 3.3 Not all code can run on both threads

Official `Thinking in ReactLynx` docs give examples like:

```tsx
lynx.getJSModule('GlobalEventEmitter').addListener(...)
```

You cannot assume APIs like this are safe on both threads. Some code may work on the background thread but fail on the main thread at runtime.

### Practical rules

- **Do not assume Lynx global APIs are callable in every execution context**
- **Check the official API docs before choosing where to call an API**
- **Prefer putting side-effect logic in `useEffect` or explicitly supported callbacks**
- **Treat cross-thread calls as architecture boundaries, not as ordinary function calls**
- In this repository specifically, treat `lynx.__globalProps` as a low-frequency host config channel.
  Dynamic keyboard avoidance must use `keyboardstatuschanged(status, height)` events instead of
  pushing live keyboard height through `globalProps`.

---

## 4. Rendering flow and React lifecycle are not the same as Web React

Official `Rendering Process and Lifecycle` docs explain that:

1. When the app starts, the **main thread renders the first screen first** so the UI appears as quickly as possible.
2. At the same time, the **background thread renders in parallel and builds the node tree**.
3. The two sides are reconciled, and later updates are synchronized back to the main thread.

### Direct implications for development

- Do not reason about lifecycle timing as if this were browser DOM React
- First-screen performance is a framework-level feature; avoid blocking code that cancels out that advantage
- Official docs note that `useEffect` runs **after main-thread DOM updates and does not block them**

### Practical suggestions

- Keep render pure
- Put heavy logic, data work, and subscription logic in background-thread-friendly places
- Avoid synchronous heavy work on the first-screen path

---

## 5. Interaction and animation: default event callbacks may introduce thread-switch latency

Official `Main Thread Script` docs explain:

- events are triggered on the main thread
- ordinary JS event handling usually runs on the background thread
- this creates a **main → background → main** thread switch
- for scroll-following UI, gestures, and animations, that can introduce visible latency

### When to think about Main Thread Script

Use it as an explicit consideration in cases like:

- direct-manipulation animations
- scroll-driven UI
- high-frequency gesture feedback
- interactions that are sensitive to latency

Official examples use patterns like:

```tsx
<view main-thread:bindscroll={onScroll} />
```

### Practical rules

- **Not every interaction should be implemented with ordinary JS callbacks**
- Evaluate high-frequency interactions for main-thread script early
- A Web-style event implementation may “work” functionally while still feeling wrong in UX terms

---

## 6. The event model is also different from the Web

Official Lynx event propagation docs use event property styles such as:

- `bind*`
- `catch*`
- `capture-bind*`
- `capture-catch*`

This is not the DOM `addEventListener` model. It is Lynx’s own event binding model.

### Practical rules

- Do not interpret Lynx events through DOM event assumptions by default
- Check element API docs first to see which event properties a given element supports
- For global-level events, check `GlobalEventEmitter` / ReactLynx global events first

---

## 7. The UI element model is not a set of HTML tags

Lynx has its own built-in element system. Common entry points include:

- `<page>`
- `<view>`
- `<text>`
- `<image>`
- `<scroll-view>`
- `<list>`
- `<input>`
- `<textarea>`
- `<overlay>`
- `<frame>`
- `<refresh>`
- `<title-bar-view>`
- `<native-element>`
- `<svg>`

Some of these come directly from official API docs; others are easy to confirm from `lynx-examples`.

### Important differences

#### `<view>`

- Similar in role to a Web `div`, but part of the Lynx element system
- Uses `className` in ReactLynx
- Should not be treated as a browser DOM node

#### `<text>`

- Has its own inline/text-layout behavior
- Official docs explicitly note that **CSS inheritance is disabled by default**
- Nested `<text>` has special inheritance-like behavior, but explicit styling is still safer overall
- Official text styling docs also emphasize that **text should live inside `<text>`, not directly inside `<view>`**

**Rule**: do not assume font size, color, and text layout styles naturally inherit the way they do on the Web.

#### `<image>`

- It is an empty element and does not support children
- It requires `src` to display correctly
- It also needs `auto-size`, or explicit non-zero width/height
- It relies on Lynx Service image-loading support

**Rule**: do not write it with ordinary `<img>` layout assumptions.

#### `<scroll-view>`

- Used for basic scrolling
- Official docs explicitly state that **Lynx does not support turning an arbitrary `view` into a scroll container via `overflow: scroll`**
- There are direct-child constraints; `sticky` only works on direct children
- Some Android sticky cases require `flatten={false}`

**Rule**: choose `scroll-view` / `list` explicitly for scrolling containers; do not port Web overflow-based solutions.

#### `<list>`

- A high-performance scrolling container
- Designed around **element reuse + lazy loading**
- Official docs emphasize that viewport dimensions need to be clear; it is well-suited to feed/infinite-scroll scenarios

**Rule**: prefer `list` for long lists; do not default to ordinary Web-style flow rendering.

## 7.1 Do not assume every documented `x-*` element is available in this host

Even when an element exists in Lynx docs or a newer XElement release, this repository's host
runtime only supports what is actually integrated and registered on each platform.

Practical rules:

- verify the iOS/Android host really includes the element implementation before using it in app code
- if a visual capability is product-critical but missing from the current host runtime, prefer a
  project-owned custom Lynx UI component over assuming the stock `x-*` element will work
- for cross-platform visual surfaces such as glass / frosted containers, prefer a repo-owned custom
  element with a stable JS API and platform-specific native implementations

Current example in this repo:

- Android host registration in `OpenCodeLynxActivity` wires the `image`
  behavior, registers the official XElement bundle via
  `builder.addBehaviors(XElementBehaviors().create())` (which provides
  `input`, `textarea`, `overlay`, and `svg`), and then adds the
  repository-owned custom elements below
- `<input>` / `<textarea>` come from the official XElement integration on
  both platforms — iOS via the `XElement` pod, Android via the
  `org.lynxsdk.lynx:xelement` Maven artifact. The XElement implementation
  exposes the imperative `setValue` / `getValue` / `focus` / `blur` /
  `setSelectionRange` UI methods that `@lynx-js/lynx-ui` relies on for
  controlled input values
- `x-liquid-glass` is a project-owned host component used for a cross-platform frosted / glass-like
  background surface
- `x-native-tabbar` is a project-owned host component used when tab selection / press feedback needs
  to be owned by native controls instead of a Lynx-drawn approximation

#### `<page>`

- The page root node
- Only one is allowed per page
- Even if you do not write `<page>` explicitly, the framework generates a root node
- Root styling is usually handled through `page` or `:root`

#### `<input>` / `<textarea>`

- Official docs mark these as elements that require extra integration support
  (`More Elements`). In this repo both elements are provided by the official
  XElement integration: iOS pulls `pod 'XElement'` in `ios/Podfile`, Android
  pulls `org.lynxsdk.lynx:xelement` (via the `lynx-xelement` alias in
  `android/gradle/libs.versions.toml`) and registers it through
  `builder.addBehaviors(XElementBehaviors().create())` in
  `OpenCodeLynxActivity`
- Use CSS `color` to style text — the `text-color` prop from earlier custom
  scaffolds is not part of XElement
- The XElement implementation provides the `setValue` / `getValue` / `focus` /
  `blur` / `setSelectionRange` UI methods that `@lynx-js/lynx-ui` calls from
  effects, so controlled inputs (`Input` / `TextArea`) hydrate correctly
- Official `<input>` examples explicitly note that **the keyboard is not
  automatically avoided** — the host activity continues to dispatch a
  `keyboardstatuschanged` global event from its WindowInsets listener for
  pages that need to react to IME visibility

**Rule**: do not assume text input behaves like the browser by default, and do not assume automatic keyboard avoidance exists.

#### `<overlay>`

- A container rendered outside the normal page layout flow
- Useful when embedding a Lynx sub-module inside a larger client page and needing an app-level overlay
- Official Chinese docs also note that in a full Lynx page, many popup scenarios can be handled with `position: fixed`

---

## 8. The styling system: knowing CSS does not mean browser assumptions are safe

Lynx supports CSS, but there are several easy pitfalls.

### 8.1 CSS inheritance is disabled by default

This matters a lot, especially for text styling.

### 8.2 Scrolling is not implemented with `overflow: scroll`

Ordinary `view` elements do not become scroll containers the way they can on the Web.

### 8.3 There are build-time capability switches

Official plugin configuration exposes options that differ from the default Web mental model, for example:

- `enableCSSInheritance`
- `customCSSInheritanceList`
- `enableCSSInvalidation`
- `enableCSSSelector`

That means:

- some CSS behavior is not “naturally browser-like”
- some selector and invalidation behavior is explicit configuration, not just assumed runtime behavior

**Rule**: follow official supported behavior and the project’s actual configuration instead of assuming browser defaults exist.

### 8.4 There are also concrete CSS compatibility differences

Based on official CSS property docs, at minimum be aware that:

- **margin does not behave with Web-style margin collapsing**
- `min-width` / `max-width` semantics, precedence, and keyword support should not be inferred from browser instincts
- some `clip-path` features differ from the Web, and some shapes/rules are unsupported

**Rule**: if complex layout, clipping, or sizing behaves strangely, check Lynx CSS property docs first rather than assuming “browser compatibility bugs.”

---

## 9. React compatibility boundaries: it is React-like, not full modern Web React

Official API docs make clear that:

- ReactLynx is mainly **React 17 API-compatible**
- it is not built directly on top of React 18’s concurrent architecture

### What that means

- Do not assume React 18/19 concurrent features are available
- Do not automatically import mental models such as `useTransition` or `useDeferredValue`
- Check official `@lynx-js/react` API docs before deciding a React feature is usable

---

## 10. Version compatibility: bundles are tightly coupled to the Lynx engine

Official `Compatibility` docs explain:

- a bundle is not automatically “compatible in all directions”
- `engineVersion` must match the Lynx Engine version in the host app
- if a bundle’s `engineVersion` is higher than the host engine version, the bundle **cannot run**

### Practical rules

- confirm the target host’s Lynx Engine version before shipping
- in multi-host-version environments, do not casually adopt the newest APIs
- official docs recommend building from source with the host app when possible

---

## 11. Container-layer constraints: navigation, storage, and bridge

This project uses a custom Lynx container. The container provides:

- **Multi-page navigation** via `navigation.open` / `navigation.close` bridge methods
- **Storage** via `storage.set` / `storage.get` / `storage.remove` bridge methods
- **Networking** via `network.request` / `network.sse.open` / `network.sse.close` bridge methods
- **Diagnostics** via `diagnostic.report` bridge method

All bridge methods are registered as a single `LynxModule` (`nativeBridge`) on both iOS and Android.

### 11.1 Navigation should not default to browser routing assumptions

Navigation uses scheme-driven routing with URLs like:

```txt
hybrid://lynxview?bundle=./chat.lynx.bundle&route_params=...
```

**Rule**: opening/closing pages should use the custom navigation bridge, not browser SPA routing instincts.

### 11.2 Storage should not default to `localStorage`

The Lynx QuickJS runtime has no `localStorage`. Use the native `storage.*` bridge methods.

### 11.3 `GlobalProps` is container-injected context

Runtime context is injected by the native container into `lynx.__globalProps`.

In this repository, host-derived layout data such as iOS and Android `safeAreaInsets` may also be injected through `GlobalProps` when page layout must match native container geometry exactly. For full-screen pages such as `main` and `chat`, prefer those host-injected inset values over CSS `env(safe-area-inset-*)` so layout matches the native container's real viewport.

**Rule**: for route params, container state, and startup parameters, check the container injection model first.

### 11.4 Networking bridge policy in this repository

The OpenCode mobile wrapper uses custom bridge networking with fixed namespaced methods:

- `network.request`
- `network.sse.open`
- `network.sse.close`

Practical guidance:

- treat these namespaced methods as the transport boundary
- do not assume any global `fetch` or global `EventSource` polyfill has been installed by the host

---

## 12. The easiest mistakes to make in current development

## 12.1 Things not to do

- Do not put side effects in render
- Do not assume render executes only once
- Do not assume every Lynx API can run on any thread
- Do not treat an ordinary `view` as a scroll container
- Do not assume CSS inheritance exists by default
- Do not assume React 18 concurrent capabilities exist
- Do not assume browser routing / `localStorage` / browser media APIs work in Lynx
- Do not ignore host `engineVersion` / container capability versions

## 12.2 Things to do first

- Identify which thread context the code is running in
- Evaluate main-thread script early for high-frequency interactions
- Prefer `list` for long lists
- Style text explicitly
- Check the native bridge for routing/storage/networking concerns
- Confirm Lynx Engine compatibility before shipping

---

## 13. Component / capability index: where to look first in current work

## 13.1 Official sites

- Lynx home: <https://lynxjs.org/>
- ReactLynx mental model: <https://lynxjs.org/react/thinking-in-reactlynx>
- Rendering process / lifecycle: <https://lynxjs.org/react/lifecycle>
- Main Thread Script: <https://lynxjs.org/react/main-thread-script>
- ReactLynx API: <https://lynxjs.org/api/react/>
- Built-in elements API index: <https://lynxjs.org/api/elements/built-in/>
- Scrolling guide: <https://lynxjs.org/guide/ui/scrolling.html>
- Compatibility guide: <https://lynxjs.org/guide/compatibility.html>

## 13.2 Official AI / LLM / agent entry points

- Lynx `llms.txt`: <https://lynxjs.org/llms.txt>
- ReactLynx Introduction (Markdown): <https://lynxjs.org/react/introduction.md>
- `AGENTS.md` for Lynx: <https://lynxjs.org/next/ai/agentsmd.html>

## 13.3 Key repository map (`lynx-family`)

- `lynx-family/lynx`
  - core engine / runtime repository
- `lynx-family/lynx-stack`
  - main frontend stack repository, including ReactLynx, Rspeedy, Lynx for Web, and related tooling
- `lynx-family/lynx-examples`
  - the best example repository to check first when you want to see the official way to build something
- `lynx-family/lynx-ui`
  - official component library repository; at the time of this research, the README still notes that public npm release is in progress
- `lynx-family/lynx-website`
  - the source for website content; useful for doc implementation details and indexing
- `lynx-family/lynx-devtool`
  - Lynx debugging tools

## 13.4 `lynx-examples` categories worth checking first

According to the `lynx-examples` README, useful categories include:

- Tutorials
  - `hello-world`
  - `tutorial-gallery`
  - `tutorial-bankcards`
  - `composing-elements`
  - `design-guide`
- Builtin Elements
  - `event`
  - `image`
  - `list`
  - `scroll-view`
  - `text`
  - `view`
  - `frame`
  - `page`
  - `refresh`
  - `title-bar-view`
  - `native-element`
- XElement
  - `input`
  - `textarea`
  - `overlay`
  - `svg`
- Styling
  - `animation`
  - `css`
  - `layout`
  - `tailwindcss`
- API
  - `fetch`
  - `lazy-bundle`
  - `external-bundle`
  - `element-manipulation`
  - `lynx-api`
  - `main-thread`
  - `local-storage`
  - `networking`
  - `react-lifecycle`
- Performance
  - `performance-apis`
  - `ifr`
- Third-party Integrations
  - `with-solidjs`
  - `zustand`
  - `tanstack-router`

> Conclusion: when you hit a concrete problem, check `lynx-examples` first, then API docs, and only then drop to source code.

---

## 14. Official components / component ecosystem status

### 14.1 Official built-in elements

Treat built-in elements as the first layer of capability:

- Layout: `page`, `view`, `frame`, `overlay`
- Text / image: `text`, `image`
- Scrolling / list: `scroll-view`, `list`, `refresh`, `swiper`
- Input: `input`, `textarea`
- Extension / bridge: `native-element`, `svg`, `title-bar-view`

### 14.2 `lynx-ui`

The `lynx-ui` README describes it as:

- officially maintained
- a headless UI library
- intended to provide flexible, reusable, high-performance UI primitives

But at the time of this research, its README also explicitly indicated:

- the repository is public
- official npm release is still being prepared

So the short-term development strategy should be:

1. build understanding through official built-in elements and examples first
2. watch the `lynx-ui` repository if you want higher-level component abstractions
3. do not assume it is already as mature and directly consumable as a typical Web component library

---

## 15. Recommended workflow for ongoing development

Before starting any new feature, run through this checklist:

### Step 1: identify which layer the problem belongs to

- Pure UI / layout issue → Lynx built-in elements / styling docs
- List / scrolling / animation issue → `list` / `scroll-view` / main-thread script
- Lifecycle / timing / data issue → ReactLynx lifecycle docs
- Navigation / storage / media / global-context issue → native bridge methods
- Host compatibility / version issue → compatibility docs + host engine version

### Step 2: check examples first

Go to `lynx-examples` first and find the closest official example.

### Step 3: then check API docs

Confirm supported properties, event names, thread restrictions, and platform constraints.

### Step 4: only abstract after you understand the primitives

Do not build a “Web-like wrapper layer” before understanding Lynx element and container constraints.

### Step 5: if you use AI / coding agents, prepare context up front

Official `AGENTS.md` docs add a very practical workflow recommendation:

- provide an `AGENTS.md` file in the project
- include at least a **Read in Advance** section
- explicitly require agents to read `llms.txt` before handling Lynx tasks

The official minimum example looks like this:

```md
## Read in Advance

Read the docs below in advance to help you understand the library or frameworks this project depends on.

- Lynx: [llms.txt](https://lynxjs.org/llms.txt).
  While dealing with a Lynx task, an agent MUST read this doc because it is an entry point of all available docs about Lynx.
```

For monorepos, the official guidance also recommends:

- a global `AGENTS.md` at the root
- project-specific `AGENTS.md` files for subprojects
- having agents read from nearest directory outward in a tree structure

If agents still refuse to read Lynx docs consistently, official guidance also suggests a stronger fallback:

```bash
curl https://lynxjs.org/llms.txt > packages/lynx/AGENTS.md
```

In other words: inline `llms.txt` directly into `AGENTS.md`.

**Practical recommendation for this repo:**

- if AI agents will participate in development frequently, keep a root `AGENTS.md`
- explicitly state that Lynx tasks must begin with `llms.txt`
- if this repo becomes a monorepo later, split `AGENTS.md` files according to the official tree-based pattern

---

## 16. One-sentence conclusion

> **Lynx = a React-like developer experience on a non-Web runtime. The custom container layer provides bridge, routing, and native-capability integration.**

The most important habits for ongoing development are:

- write UI with a React mental model
- reason about execution timing through Lynx’s thread model
- reason about layout / scrolling / events through Lynx’s element model
- reason about navigation / storage / networking through the native bridge
- if AI agents are involved, front-load official context through `llms.txt` / `AGENTS.md`

Do not treat Lynx as a browser, and do not treat it as React DOM.

---

## 17. Official sources used for this document

- Lynx home: <https://lynxjs.org/>
- Lynx `llms.txt`: <https://lynxjs.org/llms.txt>
- ReactLynx Introduction: <https://lynxjs.org/react/introduction>
- Thinking in ReactLynx: <https://lynxjs.org/react/thinking-in-reactlynx>
- Rendering Process and Lifecycle: <https://lynxjs.org/react/lifecycle>
- Main Thread Script: <https://lynxjs.org/react/main-thread-script>
- `@lynx-js/react` API: <https://lynxjs.org/api/react/>
- Global Events: <https://lynxjs.org/api/react/document.global-events>
- Event Propagation: <https://lynxjs.org/guide/interaction/event-handling/event-propagation>
- Scrolling: <https://lynxjs.org/guide/ui/scrolling.html>
- Built-in Elements APIs:
  - `page`: <https://lynxjs.org/api/elements/built-in/page.html>
  - `view`: <https://lynxjs.org/api/elements/built-in/view.html>
  - `text`: <https://lynxjs.org/api/elements/built-in/text>
  - `image`: <https://lynxjs.org/api/elements/built-in/image.html>
  - `scroll-view`: <https://lynxjs.org/api/elements/built-in/scroll-view.html>
  - `list`: <https://lynxjs.org/api/elements/built-in/list>
  - `textarea`: <https://lynxjs.org/api/elements/built-in/textarea.html>
- Compatibility: <https://lynxjs.org/guide/compatibility.html>
- `AGENTS.md` for Lynx: <https://lynxjs.org/next/ai/agentsmd.html>
- `lynx-family/lynx-stack` README: <https://github.com/lynx-family/lynx-stack>
- `lynx-family/lynx-examples` README: <https://github.com/lynx-family/lynx-examples>
- `lynx-family/lynx-ui` README: <https://github.com/lynx-family/lynx-ui>
