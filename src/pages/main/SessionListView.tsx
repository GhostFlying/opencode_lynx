import { useCallback, useEffect, useRef, useState } from '@lynx-js/react';

import { open } from '../../navigation.js';
import type {
  OpenCodeGatewayContract,
  OpenCodeGatewayEventSubscription,
} from '../../opencode/gateway.js';
import type { ProjectSummary } from '../../opencode/types.js';
import type { ConnectionContext, ConnectionTag } from './connection.js';
import { toConnectionTag } from './connection.js';

const WORKTREE_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 20 20" fill="none"><path d="M14.2036 7.19987L14.2079 6.69989L13.2079 6.69132L13.2036 7.1913L13.7036 7.19559L14.2036 7.19987ZM8.14804 5.09032H7.64804C7.64804 5.75797 7.06861 6.34471 6.29619 6.34471V6.84471V7.34471C7.56926 7.34471 8.64804 6.36051 8.64804 5.09032H8.14804ZM6.29619 6.84471V6.34471C5.52376 6.34471 4.94434 5.75797 4.94434 5.09032H4.44434H3.94434C3.94434 6.36051 5.02311 7.34471 6.29619 7.34471V6.84471ZM4.44434 5.09032H4.94434C4.94434 4.42267 5.52376 3.83594 6.29619 3.83594V3.33594V2.83594C5.02311 2.83594 3.94434 3.82013 3.94434 5.09032H4.44434ZM6.29619 3.33594V3.83594C7.06861 3.83594 7.64804 4.42267 7.64804 5.09032H8.14804H8.64804C8.64804 3.82013 7.56926 2.83594 6.29619 2.83594V3.33594ZM8.14804 14.9149H7.64804C7.64804 15.5825 7.06861 16.1693 6.29619 16.1693V16.6693V17.1693C7.56926 17.1693 8.64804 16.1851 8.64804 14.9149H8.14804ZM6.29619 16.6693V16.1693C5.52376 16.1693 4.94434 15.5825 4.94434 14.9149H4.44434H3.94434C3.94434 16.1851 5.02311 17.1693 6.29619 17.1693V16.6693ZM4.44434 14.9149H4.94434C4.94434 14.2472 5.52376 13.6605 6.29619 13.6605V13.1605V12.6605C5.02311 12.6605 3.94434 13.6447 3.94434 14.9149H4.44434ZM6.29619 13.1605V13.6605C7.06861 13.6605 7.64804 14.2472 7.64804 14.9149H8.14804H8.64804C8.64804 13.6447 7.56926 12.6605 6.29619 12.6605V13.1605ZM15.5554 5.09032H15.0554C15.0554 5.75797 14.476 6.34471 13.7036 6.34471V6.84471V7.34471C14.9767 7.34471 16.0554 6.36051 16.0554 5.09032H15.5554ZM13.7036 6.84471V6.34471C12.9312 6.34471 12.3517 5.75797 12.3517 5.09032H11.8517H11.3517C11.3517 6.36051 12.4305 7.34471 13.7036 7.34471V6.84471ZM11.8517 5.09032H12.3517C12.3517 4.42267 12.9312 3.83594 13.7036 3.83594V3.33594V2.83594C12.4305 2.83594 11.3517 3.82013 11.3517 5.09032H11.8517ZM13.7036 3.33594V3.83594C14.476 3.83594 15.0554 4.42267 15.0554 5.09032H15.5554H16.0554C16.0554 3.82013 14.9767 2.83594 13.7036 2.83594V3.33594ZM13.7036 7.19559L13.2036 7.1913L13.1544 12.9277L13.6544 12.932L14.1544 12.9363L14.2036 7.19987L13.7036 7.19559ZM6.29619 6.84471H5.79619V13.1605H6.29619H6.79619V6.84471H6.29619ZM11.6545 14.9149V14.4149H8.14804V14.9149V15.4149H11.6545V14.9149ZM13.6544 12.932L13.1544 12.9277C13.1474 13.7511 12.4779 14.4149 11.6545 14.4149V14.9149V15.4149C13.0269 15.4149 14.1426 14.3086 14.1544 12.9363L13.6544 12.932Z" fill="#64748b"/></svg>';

function px(value: number): string {
  if (!Number.isFinite(value) || value === 0) {
    return '0';
  }
  return `${value}px`;
}

interface SessionItem {
  id: string;
  title?: string;
  updatedAt?: string;
  parentID?: string;
  directory?: string;
  projectID?: string;
  project?: ProjectSummary | null;
}

export interface SessionListViewProps {
  gateway: OpenCodeGatewayContract;
  connection: ConnectionContext | null;
  onConnectionTagChange?: (tag: ConnectionTag) => void;
  header?: JSX.Element;
  contentInsetBottom?: number;
}

interface WorktreeGroup {
  directory: string;
  label: string;
  sessions: SessionItem[];
  latestUpdatedAt: string;
}

interface RepoGroup {
  projectID: string | null;
  name: string;
  worktree: string;
  worktrees: WorktreeGroup[];
  latestUpdatedAt: string;
}

function formatRelativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function shortenDirectory(dir: string): string {
  if (!dir.startsWith('/')) {
    return dir;
  }

  const segments = dir.split('/').filter(Boolean);
  if (segments.length <= 2) {
    return dir;
  }

  const tail = segments.slice(2).join('/');
  if (!tail) {
    return `~/${segments[1] ?? ''}`;
  }

  return `~/${tail}`;
}

function basename(path: string): string {
  const parts = path.replace(/\/+$/, '').split('/');
  return parts[parts.length - 1] || path;
}

function latestUpdated(sessions: SessionItem[]): string {
  let latest = '';
  for (const session of sessions) {
    if (session.updatedAt && session.updatedAt > latest) {
      latest = session.updatedAt;
    }
  }
  return latest;
}

function isRealProject(projectID: string | undefined): boolean {
  return !!projectID && projectID !== 'global';
}

function groupSessions(sessions: SessionItem[]): RepoGroup[] {
  const projectMap = new Map<string, ProjectSummary>();
  for (const session of sessions) {
    if (
      session.project &&
      isRealProject(session.projectID) &&
      !projectMap.has(session.projectID!)
    ) {
      projectMap.set(session.projectID!, session.project);
    }
  }

  const dirToProject = new Map<string, string>();
  for (const [projectID, project] of projectMap) {
    dirToProject.set(project.worktree, projectID);
  }

  const roots = sessions.filter((session) => !session.parentID);
  const buckets = new Map<string, SessionItem[]>();

  for (const session of roots) {
    let key: string;
    if (isRealProject(session.projectID)) {
      key = session.projectID!;
    } else {
      const dir = session.directory ?? '';
      let matched = dirToProject.get(dir);
      if (!matched) {
        for (const [worktree, projectID] of dirToProject) {
          if (dir.startsWith(worktree + '/')) {
            matched = projectID;
            break;
          }
        }
      }
      key = matched ?? `__dir__${dir}`;
    }

    const bucket = buckets.get(key);
    if (bucket) {
      bucket.push(session);
    } else {
      buckets.set(key, [session]);
    }
  }

  const groups: RepoGroup[] = [];

  for (const [bucketKey, bucket] of buckets) {
    const project = projectMap.get(bucketKey);
    const dirBuckets = new Map<string, SessionItem[]>();

    for (const session of bucket) {
      const dir = session.directory ?? '';
      const dirBucket = dirBuckets.get(dir);
      if (dirBucket) {
        dirBucket.push(session);
      } else {
        dirBuckets.set(dir, [session]);
      }
    }

    const projectWorktree = project?.worktree ?? '';
    const worktrees: WorktreeGroup[] = [];

    for (const [dir, dirSessions] of dirBuckets) {
      dirSessions.sort((left, right) => {
        if (!left.updatedAt) return 1;
        if (!right.updatedAt) return -1;
        return right.updatedAt.localeCompare(left.updatedAt);
      });

      let label: string;
      if (!dir || dir === projectWorktree) {
        label = 'main';
      } else if (projectWorktree && dir.startsWith(projectWorktree + '/')) {
        label = dir.slice(projectWorktree.length + 1);
      } else {
        label = basename(dir);
      }

      worktrees.push({
        directory: dir,
        label,
        sessions: dirSessions,
        latestUpdatedAt: latestUpdated(dirSessions),
      });
    }

    worktrees.sort((left, right) => right.latestUpdatedAt.localeCompare(left.latestUpdatedAt));

    groups.push({
      projectID: project ? bucketKey : null,
      name: project
        ? (project.name ?? basename(project.worktree))
        : basename(bucket[0]?.directory ?? 'Sessions'),
      worktree: projectWorktree,
      worktrees,
      latestUpdatedAt: latestUpdated(bucket),
    });
  }

  groups.sort((left, right) => right.latestUpdatedAt.localeCompare(left.latestUpdatedAt));
  return groups;
}

function formatCount(count: number, singular: string): string {
  return `${count} ${singular}${count === 1 ? '' : 's'}`;
}

function formatWorktreeLabel(label: string): string {
  if (label === 'main') {
    return 'Main worktree';
  }

  return label;
}

function shortenIdentifier(id: string): string {
  if (id.length <= 18) {
    return id;
  }
  return `${id.slice(0, 9)}...${id.slice(-6)}`;
}

function countSessions(group: RepoGroup): number {
  let total = 0;
  for (const worktree of group.worktrees) {
    total += worktree.sessions.length;
  }
  return total;
}

export function SessionListView({
  gateway,
  connection,
  onConnectionTagChange,
  header,
  contentInsetBottom = 146,
}: SessionListViewProps) {
  const [sessions, setSessions] = useState<SessionItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const mountedRef = useRef(false);
  const subscriptionRef = useRef<OpenCodeGatewayEventSubscription | null>(null);

  const fetchData = useCallback(
    async (showLoading: boolean = true) => {
      'background only';
      if (showLoading) {
        setLoading(true);
        setError(null);
      }

      try {
        const result = await gateway.sessions.list();
        setSessions(result as SessionItem[]);
      } catch (fetchError) {
        if (showLoading) {
          const message =
            fetchError instanceof Error && fetchError.message.trim().length > 0
              ? fetchError.message
              : 'Failed to load sessions.';
          setError(message);
        }
      } finally {
        if (showLoading) {
          setLoading(false);
        }
      }
    },
    [gateway]
  );

  useEffect(() => {
    if (mountedRef.current) {
      return;
    }
    mountedRef.current = true;
    void fetchData(true);
  }, [fetchData]);

  useEffect(() => {
    'background only';
    const sub = gateway.events.subscribe({
      autoStart: true,
      onLifecycleStateChange: (state) => {
        const nextTag = toConnectionTag(state.status);
        onConnectionTagChange?.(nextTag);
      },
      onEvent: (event: { type?: string; eventType?: string }) => {
        const actualType = event.type === 'unknown' ? event.eventType : event.type;
        if (
          actualType === 'session.updated' ||
          actualType === 'session.idle' ||
          actualType === 'message.updated' ||
          actualType === 'message.part.updated'
        ) {
          fetchData(false);
        }
      },
    });
    subscriptionRef.current = sub;

    return () => {
      sub.stop();
      subscriptionRef.current = null;
    };
  }, [fetchData, gateway, onConnectionTagChange]);

  const handleOpenSession = useCallback(
    (id: string, title: string) => {
      'background only';
      if (!connection) {
        setError('Connection context missing. Reconnect and try again.');
        return;
      }

      const routeParams = encodeURIComponent(
        JSON.stringify({
          sessionId: id,
          sessionTitle: title,
          connection,
        })
      );
      const scheme = `hybrid://lynxview?bundle=.%2Fchat.lynx.bundle&hide_nav_bar=1&route_params=${routeParams}`;
      open({ scheme }, () => undefined);
    },
    [connection]
  );

  const groups = groupSessions(sessions);

  return (
    <view className="session-screen">
      {error ? (
        <view className="error-banner">
          <text className="error-text">{error}</text>
        </view>
      ) : null}

      <scroll-view className="session-list-scroll" scroll-orientation="vertical">
        <view className="session-list-content" style={{ paddingBottom: px(contentInsetBottom) }}>
          {header}

          {loading ? (
            <view className="session-state-card">
              <text className="session-state-card__title">Loading sessions...</text>
              <text className="session-state-card__body">
                Fetching the latest conversation tree from your OpenCode server.
              </text>
            </view>
          ) : null}

          {!loading && !error && groups.length === 0 ? (
            <view className="session-state-card">
              <text className="session-state-card__title">No sessions yet</text>
              <text className="session-state-card__body">
                Once the server has conversations, they’ll appear here automatically.
              </text>
            </view>
          ) : null}

          {groups.map((group) => {
            const repoKey = `repo:${group.projectID ?? group.name}`;
            return (
              <view className="repo-stack-card" key={repoKey}>
                <view className="repo-stack-card__header">
                  <view className="repo-stack-card__copy">
                    <text className="repo-stack-card__eyebrow">Repository</text>
                    <text className="repo-stack-card__title">{group.name}</text>
                    <text className="repo-stack-card__meta">
                      {formatCount(countSessions(group), 'session')} across{' '}
                      {formatCount(group.worktrees.length, 'worktree')}
                    </text>
                    {group.worktree ? (
                      <text className="repo-stack-card__path">
                        {shortenDirectory(group.worktree)}
                      </text>
                    ) : null}
                  </view>
                </view>

                <view className="repo-stack-card__body">
                  {group.worktrees.map((worktree) => {
                    const worktreeKey = `${repoKey}:${worktree.directory || worktree.label}`;
                    return (
                      <view className="worktree-section" key={worktreeKey}>
                        <view className="worktree-section__header">
                          <view className="worktree-section__icon">
                            <svg content={WORKTREE_SVG} className="worktree-section__glyph" />
                          </view>

                          <view className="worktree-section__copy">
                            <text className="worktree-section__eyebrow">Worktree</text>
                            <text className="worktree-section__title">
                              {formatWorktreeLabel(worktree.label)}
                            </text>
                            {worktree.directory ? (
                              <text className="worktree-section__path">
                                {shortenDirectory(worktree.directory)}
                              </text>
                            ) : null}
                          </view>

                          <view className="worktree-section__badge">
                            <text className="worktree-section__count">
                              {formatCount(worktree.sessions.length, 'session')}
                            </text>
                          </view>
                        </view>

                        <view className="worktree-section__sessions">
                          {worktree.sessions.map((session) => {
                            const title =
                              session.title && session.title.length > 0
                                ? session.title
                                : 'Untitled';
                            const showPath =
                              !!session.directory && session.directory !== worktree.directory;

                            return (
                              <view
                                key={session.id}
                                className="session-row"
                                bindtap={() => {
                                  'background only';
                                  handleOpenSession(session.id, title);
                                }}
                              >
                                <text className="session-row__eyebrow">Session</text>
                                <view className="session-row__topline">
                                  <text className="session-card__title">{title}</text>
                                  {session.updatedAt ? (
                                    <text className="session-card__time">
                                      {formatRelativeTime(session.updatedAt)}
                                    </text>
                                  ) : null}
                                </view>
                                <view className="session-row__meta">
                                  <text className="session-card__id">
                                    {shortenIdentifier(session.id)}
                                  </text>
                                </view>
                                {showPath ? (
                                  <text className="session-card__path">
                                    {shortenDirectory(session.directory!)}
                                  </text>
                                ) : null}
                              </view>
                            );
                          })}
                        </view>
                      </view>
                    );
                  })}
                </view>
              </view>
            );
          })}
        </view>
      </scroll-view>
    </view>
  );
}
