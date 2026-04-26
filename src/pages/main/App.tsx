import { useCallback, useEffect, useMemo, useRef, useState } from '@lynx-js/react';
import { Button, KeyboardAwareResponder, KeyboardAwareRoot } from '@lynx-js/lynx-ui';

import './App.css';
import appLogo from '../../assets/app_icon.png';
import { LandingView } from './LandingView.js';
import { SessionListView } from './SessionListView.js';
import { SettingsView } from './SettingsView.js';
import {
  clearSavedConnection,
  cloneConnection,
  connectionTagTone,
  connectToBackendClient,
  defaultConnection,
  readSavedConnectionWithRetry,
} from './connection.js';
import type { ConnectionContext, ConnectionFormStatus, ConnectionTag } from './connection.js';
import type { BackendClient } from '../../backends/index.js';
import type { TouchEvent } from '@lynx-js/types';
import { px, readSafeAreaInsetsFromGlobalProps } from '../../safeArea.js';

const MAIN_READY_MARKER = 'main_ready_marker' as const;
const OPEN_SECOND_PAGE_ACTION_MARKER = 'open_second_page_action' as const;
const MAIN_READY_SIGNAL_MARKER_PREFIX = 'qa_main_ready_signal_v1' as const;
const READY_SIGNAL_RETRY_DELAYS_MS = [0, 200, 500] as const;
const MAX_READY_SIGNAL_ATTEMPTS = READY_SIGNAL_RETRY_DELAYS_MS.length;

// attemptConnect handles expected connection failures internally. This catches
// unexpected rejects from the async boundary so Lynx does not report them as an
// unhandled rejection loop during startup.
function silenceAutoConnectError(error: unknown): void {
  console.warn(
    'main_auto_connect_swallowed',
    error instanceof Error ? error.message : String(error)
  );
}

type ReadySignalAttempt = 1 | 2 | 3;
type ViewState = 'landing' | 'connected';
type ConnectedTab = 'sessions' | 'settings';
type PressedTab = ConnectedTab | '';
export interface MainPageProps {
  onMounted?: () => void;
  readySignalSender?: ReadySignalSender;
  readyRunId?: string;
  startupDataReady?: boolean;
  uiReadyPredicate?: (input: UiReadyPredicateInput) => boolean;
  nowMs?: () => number;
}

export interface UiReadyPredicateInput {
  markerRendered: boolean;
  startupDataReady: boolean;
  runId: string;
}

export type ReadySignalSender = (payload: ReadySignalPayload) => void;

export interface ReadySignalPayload {
  report_id: string;
  run_id: string;
  timestamp: number;
  phase: ReadyPhase;
  status: ReadyStatus;
  reason?: string;
}

export type ReadyPhase = 'react_ready' | 'ui_ready';
export type ReadyStatus = 'ok' | 'warning' | 'error';

const TABBAR_WIDTH_PX = 366;
const TABBAR_INTERNAL_PADDING_PX = 12;
const TABBAR_FLOAT_SAFE_AREA_DELTA_PX = -4;
const SCROLL_CONTENT_INSET_BOTTOM_PX = 146;

function resolvePressedTabFromTouch(event: TabTouchProxyEvent): PressedTab {
  const touch = event.changedTouches?.[0] ?? event.touches?.[0];
  const left = Number(event.currentTarget?.dataset?.left ?? '0');
  const width = Number(event.currentTarget?.dataset?.width ?? `${TABBAR_WIDTH_PX}`);
  if (!touch || !Number.isFinite(touch.pageX) || !Number.isFinite(left) || !Number.isFinite(width) || width <= 0) {
    return '';
  }

  const localX = touch.pageX - left;
  return localX >= width / 2 ? 'settings' : 'sessions';
}

function emitRuntimeQaMarker(marker: string) {
  console.info(marker);
  console.info('qa_runtime_marker_v1', marker);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function normalizeRunId(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function readRunIdFromGlobalProps(): string | null {
  if (typeof lynx === 'undefined') {
    return null;
  }

  const globalProps = lynx.__globalProps;
  if (!isRecord(globalProps)) {
    return null;
  }

  const globalRunId = normalizeRunId(globalProps.run_id);
  if (globalRunId) {
    return globalRunId;
  }

  const queryItems = globalProps.queryItems;
  if (!isRecord(queryItems)) {
    return null;
  }

  return normalizeRunId(queryItems.run_id);
}

const defaultUiReadyPredicate = ({
  markerRendered,
  startupDataReady,
  runId,
}: UiReadyPredicateInput): boolean => {
  return markerRendered && startupDataReady && runId.length > 0;
};

const defaultReadySignalSender: ReadySignalSender = (payload) => {
  emitRuntimeQaMarker(toMainReadySignalMarker(payload));
  console.info('lynx_readiness_signal', payload);
};

function readySeqForPhase(phase: ReadyPhase): 1 | 2 {
  return phase === 'react_ready' ? 1 : 2;
}

function toMainReadySignalMarker(payload: ReadySignalPayload): string {
  return `${MAIN_READY_SIGNAL_MARKER_PREFIX}|phase=${payload.phase}|seq=${readySeqForPhase(payload.phase)}|run_id=${payload.run_id}`;
}

function plusIcon(): string {
  return '+';
}

function chromeShellClassName(view: ViewState): string {
  return view === 'connected' ? 'chrome-shell chrome-shell--connected' : 'chrome-shell';
}

interface NativeTabChangeEvent {
  detail?: {
    value?: string;
  };
}

interface TabTouchProxyEvent extends TouchEvent {
  currentTarget: TouchEvent['currentTarget'] & {
    dataset: {
      left?: string;
      width?: string;
    };
  };
}

export function App({
  onMounted,
  readySignalSender = defaultReadySignalSender,
  readyRunId,
  startupDataReady = true,
  uiReadyPredicate = defaultUiReadyPredicate,
  nowMs = Date.now,
}: MainPageProps) {
  const [uiReadyMarkerRendered, setUiReadyMarkerRendered] = useState(false);
  const [emittedSignals, setEmittedSignals] = useState<ReadySignalPayload[]>([]);
  const mountedRef = useRef(false);
  const reactReadyEmittedRef = useRef(false);
  const uiReadyEmittedRef = useRef(false);
  const retryTimeoutRef = useRef<Record<ReadyPhase, ReturnType<typeof setTimeout> | null>>({
    react_ready: null,
    ui_ready: null,
  });

  const [view, setView] = useState<ViewState>('landing');
  const [activeTab, setActiveTab] = useState<ConnectedTab>('sessions');
  const [pressedTab, setPressedTab] = useState<PressedTab>('');
  const [connection, setConnection] = useState<ConnectionContext>(defaultConnection());
  const [connectionStatus, setConnectionStatus] = useState<ConnectionFormStatus>('idle');
  const [connectionError, setConnectionError] = useState('');
  const [connectionTag, setConnectionTag] = useState<ConnectionTag>('Idle');
  const [hydrated, setHydrated] = useState(false);
  const clientRef = useRef<BackendClient | null>(null);
  const connectingRef = useRef(false);
  const autoConnectRef = useRef(true);
  const restoredConnectionRef = useRef<ConnectionContext | null>(null);

  const resolvedRunId = normalizeRunId(readyRunId) ?? readRunIdFromGlobalProps();
  const safeAreaInsets = readSafeAreaInsetsFromGlobalProps();
  const chromeShellStyle =
    view === 'connected'
      ? {
          paddingTop: 0,
          paddingRight: 0,
          paddingBottom: 0,
          paddingLeft: 0,
        }
      : {
          paddingTop: px(safeAreaInsets.top + 18),
          paddingRight: '18px',
          paddingBottom: '22px',
          paddingLeft: '18px',
        };
  const connectedTopbarStyle = {
    paddingTop: px(safeAreaInsets.top + 12),
  };
  const tabbarFloatStyle = {
    left: '18px',
    right: '18px',
    bottom: px(Math.max(0, safeAreaInsets.bottom + TABBAR_FLOAT_SAFE_AREA_DELTA_PX)),
  };
  const tabbarTouchProxyStyle = {
    left: `${TABBAR_INTERNAL_PADDING_PX}px`,
    right: `${TABBAR_INTERNAL_PADDING_PX}px`,
    top: `${TABBAR_INTERNAL_PADDING_PX}px`,
    bottom: `${TABBAR_INTERNAL_PADDING_PX}px`,
  };
  const scrollContentInsetBottom = safeAreaInsets.bottom + SCROLL_CONTENT_INSET_BOTTOM_PX;
  const headerStatusText = useMemo(() => {
    if (view === 'landing') {
      if (connectionStatus === 'connecting') {
        return 'Connecting';
      }
      if (connectionStatus === 'error') {
        return 'Connection needed';
      }
      return 'Ready to connect';
    }

    return connectionTag;
  }, [connectionStatus, connectionTag, view]);
  const headerStatusTone = useMemo(() => {
    if (view === 'connected') {
      return connectionTagTone(connectionTag);
    }
    if (connectionStatus === 'connecting') {
      return 'warning';
    }
    if (connectionStatus === 'error') {
      return 'offline';
    }
    return 'idle';
  }, [connectionStatus, connectionTag, view]);

  const clearRetryTimeout = useCallback((phase: ReadyPhase) => {
    const timer = retryTimeoutRef.current[phase];
    if (timer !== null) {
      clearTimeout(timer);
      retryTimeoutRef.current[phase] = null;
    }
  }, []);

  const emitReadySignalWithRetry = useCallback(
    (phase: ReadyPhase) => {
      if (!resolvedRunId) {
        return;
      }

      const emitAttempt = (attempt: ReadySignalAttempt) => {
        const payload: ReadySignalPayload = {
          report_id: `${resolvedRunId}:${phase}:${attempt}`,
          run_id: resolvedRunId,
          timestamp: nowMs(),
          phase,
          status: 'ok',
        };

        try {
          readySignalSender(payload);
          clearRetryTimeout(phase);
          setEmittedSignals((previous) => {
            return previous.some((entry) => entry.phase === payload.phase)
              ? previous
              : [...previous, payload];
          });
        } catch (error) {
          if (attempt >= MAX_READY_SIGNAL_ATTEMPTS) {
            clearRetryTimeout(phase);
            console.error('lynx_readiness_signal_emit_failed', {
              phase,
              attempt,
              run_id: resolvedRunId,
              error: error instanceof Error ? error.message : String(error),
            });
            return;
          }

          const nextAttempt = (attempt + 1) as ReadySignalAttempt;
          const delay =
            READY_SIGNAL_RETRY_DELAYS_MS[nextAttempt - 1] -
            READY_SIGNAL_RETRY_DELAYS_MS[attempt - 1];

          clearRetryTimeout(phase);
          retryTimeoutRef.current[phase] = setTimeout(() => {
            emitAttempt(nextAttempt);
          }, delay);
        }
      };

      emitAttempt(1);
    },
    [clearRetryTimeout, nowMs, readySignalSender, resolvedRunId]
  );

  useEffect(() => {
    if (mountedRef.current) {
      return;
    }

    mountedRef.current = true;
    emitRuntimeQaMarker(MAIN_READY_MARKER);
    emitRuntimeQaMarker(OPEN_SECOND_PAGE_ACTION_MARKER);
    setUiReadyMarkerRendered(true);
    onMounted?.();
  }, [onMounted]);

  useEffect(() => {
    if (reactReadyEmittedRef.current || !resolvedRunId) {
      return;
    }

    reactReadyEmittedRef.current = true;
    emitReadySignalWithRetry('react_ready');
  }, [emitReadySignalWithRetry, resolvedRunId]);

  useEffect(() => {
    if (uiReadyEmittedRef.current) {
      return;
    }

    if (!resolvedRunId) {
      return;
    }

    const hasReactReadySignal = emittedSignals.some((entry) => entry.phase === 'react_ready');
    if (!hasReactReadySignal) {
      return;
    }

    const shouldEmitUiReady = uiReadyPredicate({
      markerRendered: uiReadyMarkerRendered,
      startupDataReady,
      runId: resolvedRunId,
    });

    if (!shouldEmitUiReady) {
      return;
    }

    uiReadyEmittedRef.current = true;
    emitReadySignalWithRetry('ui_ready');
  }, [
    emitReadySignalWithRetry,
    emittedSignals,
    resolvedRunId,
    startupDataReady,
    uiReadyMarkerRendered,
    uiReadyPredicate,
  ]);

  useEffect(() => {
    return () => {
      clearRetryTimeout('react_ready');
      clearRetryTimeout('ui_ready');
    };
  }, [clearRetryTimeout]);

  useEffect(() => {
    void (async () => {
      'background only';
      try {
        const saved = await readSavedConnectionWithRetry();
        const nextConnection = saved ?? defaultConnection();
        restoredConnectionRef.current = saved ? cloneConnection(saved) : null;
        setConnection(nextConnection);
        setHydrated(true);
      } catch (error) {
        // Keep the async IIFE from rejecting during startup; the visible form
        // remains usable with the default connection values.
        console.warn(
          'main_hydrate_failed',
          error instanceof Error ? error.message : String(error)
        );
        setHydrated(true);
      }
    })();
  }, []);

  const handleConnectSuccess = useCallback(
    (client: BackendClient, nextConnection: ConnectionContext) => {
      clientRef.current = client;
      setConnection(cloneConnection(nextConnection));
      setConnectionStatus('connected');
      setConnectionError('');
      setConnectionTag('Connecting');
      setActiveTab('sessions');
      setView('connected');
    },
    []
  );

  const attemptConnect = useCallback(
    async (nextConnection: ConnectionContext) => {
      'background only';
      if (connectingRef.current) {
        return;
      }

      connectingRef.current = true;
      setConnectionStatus('connecting');
      setConnectionError('');
      setConnection(cloneConnection(nextConnection));

      try {
        const result = await connectToBackendClient(nextConnection);
        handleConnectSuccess(result.client, result.connection);
      } catch (error) {
        const message =
          error instanceof Error && error.message.trim().length > 0
            ? error.message
            : 'Connection failed. Check server address and try again.';
        setConnectionStatus('error');
        setConnectionError(message);
        setConnectionTag('Offline');
        setView('landing');
      } finally {
        connectingRef.current = false;
      }
    },
    [handleConnectSuccess]
  );

  useEffect(() => {
    if (!hydrated || !autoConnectRef.current) {
      return;
    }

    autoConnectRef.current = false;
    const initialConnection = restoredConnectionRef.current ?? connection;
    restoredConnectionRef.current = null;
    attemptConnect(initialConnection).catch(silenceAutoConnectError);
  }, [attemptConnect, connection, hydrated]);

  const handleConnectionChange = useCallback(
    (next: ConnectionContext) => {
      'background only';
      setConnection(cloneConnection(next));
      if (connectionStatus === 'error') {
        setConnectionStatus('idle');
        setConnectionError('');
      }
    },
    [connectionStatus]
  );

  const handleConnect = useCallback(() => {
    'background only';
    attemptConnect(connection).catch(silenceAutoConnectError);
  }, [attemptConnect, connection]);

  const handleReconnect = useCallback(() => {
    'background only';
    attemptConnect(connection).catch(silenceAutoConnectError);
  }, [attemptConnect, connection]);

  const handleDisconnect = useCallback(() => {
    'background only';
    clientRef.current = null;
    clearSavedConnection();
    setConnectionStatus('idle');
    setConnectionError('');
    setConnectionTag('Idle');
    setPressedTab('');
    setActiveTab('sessions');
    setView('landing');
  }, []);

  const handleTabChange = useCallback((tab: ConnectedTab) => {
    'background only';
    console.info('native_tabbar_js_apply_tab', { tab });
    setActiveTab(tab);
  }, []);

  const handleNativeTabChange = useCallback(
    (event: NativeTabChangeEvent) => {
      'background only';
      const nextValue = event.detail?.value;
      console.info('native_tabbar_js_received_event', {
        type: 'tabchange',
        detail: event.detail,
      });
      if (nextValue === 'sessions' || nextValue === 'settings') {
        handleTabChange(nextValue);
      } else {
        console.info('native_tabbar_js_ignored_event', {
          detail: event.detail,
        });
      }
    },
    [handleTabChange]
  );

  const handleTabTouchStart = useCallback((event: TabTouchProxyEvent) => {
    'background only';
    const nextPressedTab = resolvePressedTabFromTouch(event);
    console.info('native_tabbar_js_touch_start', {
      detail: event.detail,
      pageX: event.changedTouches?.[0]?.pageX ?? event.touches?.[0]?.pageX,
      pressed: nextPressedTab,
    });
    setPressedTab(nextPressedTab);
  }, []);

  const handleTabTouchMove = useCallback((event: TabTouchProxyEvent) => {
    'background only';
    setPressedTab(resolvePressedTabFromTouch(event));
  }, []);

  const handleTabTouchCancel = useCallback(() => {
    'background only';
    setPressedTab('');
  }, []);

  const handleTabTouchEnd = useCallback(
    (event: TabTouchProxyEvent) => {
      'background only';
      const nextPressedTab = resolvePressedTabFromTouch(event);
      console.info('native_tabbar_js_touch_end', {
        detail: event.detail,
        pageX: event.changedTouches?.[0]?.pageX ?? event.touches?.[0]?.pageX,
        pressed: nextPressedTab,
      });
      setPressedTab('');
      if (nextPressedTab === 'sessions' || nextPressedTab === 'settings') {
        handleTabChange(nextPressedTab);
      }
    },
    [handleTabChange]
  );

  const handlePlusTap = useCallback(() => {
    'background only';
    console.info('main_plus_placeholder_tapped');
  }, []);

  return (
    <view className="main-page">
      <view className="qa-markers">
        {uiReadyMarkerRendered ? (
          <view>
            <text className="qa-marker-text">{MAIN_READY_MARKER}</text>
          </view>
        ) : null}
        {emittedSignals.map((signal) => {
          return (
            <text className="qa-marker-text" key={signal.report_id}>
              {toMainReadySignalMarker(signal)}
            </text>
          );
        })}
      </view>

      <view className={chromeShellClassName(view)} style={chromeShellStyle}>
        <KeyboardAwareRoot androidStatusBarPlusBottomBarHeight={safeAreaInsets.bottom}>
          <view className="content-shell">
            {view === 'landing' ? (
              <KeyboardAwareResponder
                as="ScrollView"
                scrollviewId="landing-scroll"
                className="landing-scroll"
              >
                <view className="hero">
                  <view className="hero__mark">
                    <image src={appLogo} className="hero__logo" />
                  </view>
                  <text className="hero__title">OpenCode</text>
                  <text className="hero__subtitle">
                    A calmer mobile surface for sessions and server status.
                  </text>
                </view>

                <LandingView
                  connection={connection}
                  status={connectionStatus}
                  errorMessage={connectionError}
                  onChange={handleConnectionChange}
                  onSubmit={handleConnect}
                />
              </KeyboardAwareResponder>
            ) : null}

            {view === 'connected' && clientRef.current ? (
              <view className="connected-shell">
                <view className="connected-shell__content">
                  {activeTab === 'sessions' ? (
                    <SessionListView
                      client={clientRef.current}
                      connection={connection}
                      onConnectionTagChange={setConnectionTag}
                      header={
                        <view className="topbar topbar--content" style={connectedTopbarStyle}>
                          <view className="topbar__brand">
                            <image src={appLogo} className="topbar__logo" />
                          </view>

                          <view className="topbar__center">
                            <view className={`status-pill status-pill--${headerStatusTone}`}>
                              <view className="status-pill__dot" />
                              <text className="status-pill__text">{headerStatusText}</text>
                            </view>
                          </view>

                          <Button className="icon-button" onClick={handlePlusTap}>
                            <view className="icon-button__inner">
                              <text className="icon-button__text">{plusIcon()}</text>
                            </view>
                          </Button>
                        </view>
                      }
                      contentInsetBottom={scrollContentInsetBottom}
                    />
                  ) : (
                    <SettingsView
                      connection={connection}
                      status={connectionStatus}
                      errorMessage={connectionError}
                      connectionTag={connectionTag}
                      onChange={handleConnectionChange}
                      onReconnect={handleReconnect}
                      onDisconnect={handleDisconnect}
                      header={
                        <view className="topbar topbar--content" style={connectedTopbarStyle}>
                          <view className="topbar__spacer" />

                          <view className="topbar__center">
                            <text className="topbar__title">Settings</text>
                          </view>

                          <view className="topbar__spacer" />
                        </view>
                      }
                      contentInsetBottom={scrollContentInsetBottom}
                    />
                  )}
                </view>

                <view className="tabbar-float" style={tabbarFloatStyle}>
                  <view className="tabbar-stack">
                    <x-liquid-glass
                      className="tabbar-glass"
                      variant="bar"
                      corner-radius="24px"
                      tint-alpha="0.18"
                    />

                    <view className="tabbar-surface">
                      <x-native-tabbar
                        className="tabbar-native"
                        selected={activeTab}
                        pressed={pressedTab}
                        sessions-label="Sessions"
                        settings-label="Settings"
                        bindtabchange={handleNativeTabChange}
                      />
                    </view>

                    <view
                      className="tabbar-touch-proxy"
                      data-left="30"
                      data-width="342"
                      style={tabbarTouchProxyStyle}
                      bindtouchstart={handleTabTouchStart}
                      bindtouchmove={handleTabTouchMove}
                      bindtouchend={handleTabTouchEnd}
                      bindtouchcancel={handleTabTouchCancel}
                    />
                  </view>
                </view>
              </view>
            ) : null}
          </view>
        </KeyboardAwareRoot>
      </view>
    </view>
  );
}
