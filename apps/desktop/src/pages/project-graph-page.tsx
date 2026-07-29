import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
  type WheelEvent,
} from "react";
import { parseUuidV7 } from "@inkshadow/domain";
import type { GraphEntity, GraphRelation } from "@inkshadow/search-core";
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  EmptyState,
  ErrorState,
  InlineAlert,
  PageStateBoundary,
} from "@inkshadow/ui";
import { Link } from "react-router-dom";

import {
  type StoryGraphInspection,
  type StoryGraphRuntimePort,
} from "../infrastructure/story-graph-runtime";
import { normalizeUiError } from "../infrastructure/ui-error";
import "./project-graph-page.css";

const INITIAL_NODE_LIMIT = 120;
const NODE_LIMIT_STEP = 120;
const MIN_ZOOM = 0.5;
const MAX_ZOOM = 2.5;

interface ProjectGraphPageProps {
  readonly graph: StoryGraphRuntimePort;
  readonly projectId: string;
}

type PagePhase = "fatal_error" | "loading" | "ready";

interface PositionedGraphEntity {
  readonly entity: GraphEntity;
  readonly x: number;
  readonly y: number;
}

interface GraphLayout {
  readonly width: number;
  readonly height: number;
  readonly nodes: readonly PositionedGraphEntity[];
}

interface ViewportTransform {
  readonly x: number;
  readonly y: number;
  readonly zoom: number;
}

interface PointerDrag {
  readonly pointerId: number;
  readonly clientX: number;
  readonly clientY: number;
  readonly originX: number;
  readonly originY: number;
}

export function ProjectGraphPage({ graph, projectId: projectIdValue }: ProjectGraphPageProps) {
  const parsedProjectId = useMemo(() => parseUuidV7(projectIdValue), [projectIdValue]);
  const projectId = parsedProjectId.ok ? parsedProjectId.value : null;
  const [phase, setPhase] = useState<PagePhase>("loading");
  const [inspection, setInspection] = useState<StoryGraphInspection | null>(null);
  const [loadError, setLoadError] = useState<unknown>(
    parsedProjectId.ok ? null : parsedProjectId.error,
  );
  const [rebuildError, setRebuildError] = useState<unknown>(null);
  const [rebuilding, setRebuilding] = useState(false);
  const [enabledKinds, setEnabledKinds] = useState<ReadonlySet<string>>(new Set());
  const [selectedEntityId, setSelectedEntityId] = useState<string | null>(null);
  const [nodeLimit, setNodeLimit] = useState(INITIAL_NODE_LIMIT);
  const [viewport, setViewport] = useState<ViewportTransform>({ x: 0, y: 0, zoom: 1 });

  const load = useCallback(async () => {
    if (projectId === null) {
      setPhase("fatal_error");
      return;
    }
    setPhase("loading");
    const result = await graph.inspectProject(projectId);
    if (!result.ok) {
      setLoadError(result.error);
      setPhase("fatal_error");
      return;
    }
    const nextEntities = result.value.projection?.entities ?? [];
    setEnabledKinds(new Set(nextEntities.map(({ kind }) => kind)));
    setSelectedEntityId(nextEntities[0]?.id ?? null);
    setNodeLimit(INITIAL_NODE_LIMIT);
    setViewport({ x: 0, y: 0, zoom: 1 });
    setInspection(result.value);
    setLoadError(null);
    setPhase("ready");
  }, [graph, projectId]);

  useEffect(() => {
    void Promise.resolve().then(load);
  }, [load]);

  const projection = inspection?.projection ?? null;
  const allEntities = useMemo(() => projection?.entities ?? [], [projection]);
  const allRelations = useMemo(() => projection?.relations ?? [], [projection]);
  const kinds = useMemo(
    () => [...new Set(allEntities.map(({ kind }) => kind))].sort(compareGraphKinds),
    [allEntities],
  );

  const filteredEntities = useMemo(
    () => allEntities.filter(({ kind }) => enabledKinds.has(kind)),
    [allEntities, enabledKinds],
  );
  const displayedEntities = useMemo(
    () => filteredEntities.slice(0, nodeLimit),
    [filteredEntities, nodeLimit],
  );
  const displayedEntityIds = useMemo(
    () => new Set(displayedEntities.map(({ id }) => id)),
    [displayedEntities],
  );
  const displayedRelations = useMemo(
    () =>
      allRelations.filter(
        ({ fromEntityId, toEntityId }) =>
          displayedEntityIds.has(fromEntityId) && displayedEntityIds.has(toEntityId),
      ),
    [allRelations, displayedEntityIds],
  );
  const selectedEntity =
    displayedEntities.find(({ id }) => id === selectedEntityId) ?? displayedEntities[0] ?? null;
  const selectedRelations =
    selectedEntity === null
      ? []
      : allRelations.filter(
          ({ fromEntityId, toEntityId }) =>
            fromEntityId === selectedEntity.id || toEntityId === selectedEntity.id,
        );

  async function rebuild(): Promise<void> {
    if (projectId === null || rebuilding) {
      return;
    }
    setRebuilding(true);
    setRebuildError(null);
    try {
      const result = await graph.rebuildProject(projectId);
      if (!result.ok) {
        setRebuildError(result.error);
        return;
      }
      await load();
    } catch (cause: unknown) {
      setRebuildError(cause);
    } finally {
      setRebuilding(false);
    }
  }

  function toggleKind(kind: string): void {
    setEnabledKinds((current) => {
      const next = new Set(current);
      if (next.has(kind)) {
        next.delete(kind);
      } else {
        next.add(kind);
      }
      return next;
    });
    setNodeLimit(INITIAL_NODE_LIMIT);
  }

  const normalizedLoadError = loadError === null ? null : normalizeUiError(loadError);
  const normalizedRebuildError = rebuildError === null ? null : normalizeUiError(rebuildError);
  const isEmpty = projection === null || allEntities.length === 0;

  return (
    <div className="desktop-page project-graph-page">
      <header className="page-heading">
        <div>
          <Link className="back-link" to={`/projects/${projectIdValue}`}>
            返回项目
          </Link>
          <h1>故事关系图</h1>
          <p>只读派生视图：正式故事记录仍是唯一真相，关系不会反向写入正文。</p>
        </div>
        <div className="settings-actions">
          <Badge tone="info">GraphRAG 派生投影</Badge>
          {projection !== null && (
            <Button loading={rebuilding} onClick={() => void rebuild()}>
              重建关系图
            </Button>
          )}
        </div>
      </header>

      <InlineAlert
        tone="info"
        title="图谱只提供候选上下文"
        description="虚线边表示已由人工接受或修改的抽取建议及其精确章节证据；系统不会从文本猜测人物关系，也不会自动发布正式内容。"
      />

      {inspection?.freshness === "stale" && (
        <InlineAlert
          tone="warning"
          title="当前投影已过期"
          description="正式记录或章节证据已变化。旧图仍保持只读，请重建后再将其用于上下文检索。"
        />
      )}

      {inspection?.authoritative.partial === true && (
        <InlineAlert
          tone="warning"
          title="部分章节证据未进入投影"
          description={`有 ${String(
            inspection.authoritative.projectionOmissionCount,
          )} 条人审证据因图谱内容策略被安全省略；省略项不会提供给 GraphRAG 查询。`}
        />
      )}

      {projection?.status === "paused" && (
        <InlineAlert
          tone="warning"
          title="投影已暂停"
          description="当前图可供检查，但暂停状态下不会提供 GraphRAG 上下文。重建可恢复派生投影。"
        />
      )}

      {normalizedRebuildError !== null && (
        <InlineAlert
          tone="error"
          title="关系图重建失败"
          description={`${normalizedRebuildError.description}（${normalizedRebuildError.code}）`}
        />
      )}

      <PageStateBoundary
        state={phase}
        preserveContent={false}
        loadingLabel="正在核对正式记录与章节证据"
        fallbacks={{
          fatal_error:
            normalizedLoadError === null ? undefined : (
              <ErrorState
                title={normalizedLoadError.title}
                description={normalizedLoadError.description}
                errorCode={normalizedLoadError.code}
                primaryAction={{ label: "重试", onClick: () => void load() }}
              />
            ),
        }}
      >
        {isEmpty ? (
          <EmptyState
            title={
              inspection?.authoritative.formalRecordCount === 0
                ? "还没有可投影的正式故事记录"
                : "关系图尚未构建"
            }
            description={
              inspection?.authoritative.formalRecordCount === 0
                ? "先在故事治理中建立正式角色、世界规则、伏笔或时间线事件。"
                : "构建会读取当前正式记录与仍有效的精确章节证据，不会修改正式内容。"
            }
            primaryAction={{
              label: projection === null ? "构建关系图" : "重新核对",
              onClick: () => void rebuild(),
            }}
          />
        ) : (
          <>
            <GraphSummary inspection={inspection} />

            <section className="project-graph-workspace" aria-labelledby="graph-canvas-title">
              <Card className="project-graph-main-card">
                <CardHeader>
                  <div className="project-graph-card-heading">
                    <div>
                      <CardTitle id="graph-canvas-title">关系图画布</CardTitle>
                      <p>虚线为派生边；选择节点可核对正式来源与章节证据。</p>
                    </div>
                    <div className="project-graph-legend" aria-label="关系图图例">
                      <span>
                        <i className="project-graph-legend__node" aria-hidden="true" />
                        节点
                      </span>
                      <span>
                        <i className="project-graph-legend__edge" aria-hidden="true" />
                        派生证据边
                      </span>
                    </div>
                  </div>
                </CardHeader>
                <CardContent>
                  <fieldset className="project-graph-filters">
                    <legend>按节点类型筛选</legend>
                    {kinds.map((kind) => (
                      <label key={kind}>
                        <input
                          type="checkbox"
                          checked={enabledKinds.has(kind)}
                          onChange={() => toggleKind(kind)}
                        />
                        <span>{graphKindLabel(kind)}</span>
                        <Badge>{allEntities.filter((entity) => entity.kind === kind).length}</Badge>
                      </label>
                    ))}
                  </fieldset>

                  <GraphCanvas
                    entities={displayedEntities}
                    relations={displayedRelations}
                    selectedEntityId={selectedEntity?.id ?? null}
                    viewport={viewport}
                    onSelect={setSelectedEntityId}
                    onViewportChange={setViewport}
                  />

                  {filteredEntities.length > displayedEntities.length && (
                    <div className="project-graph-more">
                      <span role="status">
                        当前展示 {displayedEntities.length} / {filteredEntities.length} 个节点
                      </span>
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={() => setNodeLimit((current) => current + NODE_LIMIT_STEP)}
                      >
                        显示更多节点
                      </Button>
                    </div>
                  )}
                </CardContent>
              </Card>

              <GraphEntityDetails
                entity={selectedEntity}
                relations={selectedRelations}
                projectId={projectIdValue}
              />
            </section>

            <AccessibleGraphList
              entities={displayedEntities}
              relations={displayedRelations}
              selectedEntityId={selectedEntity?.id ?? null}
              onSelect={setSelectedEntityId}
            />
          </>
        )}
      </PageStateBoundary>

      <p className="sr-only" aria-live="polite">
        {rebuilding ? "正在重建故事关系图" : ""}
      </p>
    </div>
  );
}

function GraphSummary({ inspection }: { readonly inspection: StoryGraphInspection | null }) {
  const projection = inspection?.projection;
  if (inspection === null || projection === null || projection === undefined) {
    return null;
  }
  return (
    <section className="project-graph-summary" aria-label="关系图摘要">
      <Card>
        <CardContent>
          <strong>{projection.entities.length}</strong>
          <span>节点</span>
        </CardContent>
      </Card>
      <Card>
        <CardContent>
          <strong>{projection.relations.length}</strong>
          <span>派生边</span>
        </CardContent>
      </Card>
      <Card>
        <CardContent>
          <strong>r{projection.revision}</strong>
          <span>投影修订</span>
        </CardContent>
      </Card>
      <Card>
        <CardContent>
          <strong>{formatTimestamp(projection.lastRebuiltAt ?? projection.updatedAt)}</strong>
          <span>最近重建</span>
        </CardContent>
      </Card>
      {inspection.authoritative.invalidatedSupportCount > 0 && (
        <Card>
          <CardContent>
            <strong>{inspection.authoritative.invalidatedSupportCount}</strong>
            <span>已失效证据</span>
          </CardContent>
        </Card>
      )}
      {inspection.authoritative.projectionOmissionCount > 0 && (
        <Card>
          <CardContent>
            <strong>{inspection.authoritative.projectionOmissionCount}</strong>
            <span>策略省略</span>
          </CardContent>
        </Card>
      )}
    </section>
  );
}

/* eslint-disable jsx-a11y/no-noninteractive-element-interactions, jsx-a11y/no-noninteractive-tabindex -- the ARIA application canvas intentionally owns pan/zoom keyboard and pointer input */
function GraphCanvas({
  entities,
  onSelect,
  onViewportChange,
  relations,
  selectedEntityId,
  viewport,
}: {
  readonly entities: readonly GraphEntity[];
  readonly relations: readonly GraphRelation[];
  readonly selectedEntityId: string | null;
  readonly viewport: ViewportTransform;
  readonly onSelect: (entityId: string) => void;
  readonly onViewportChange: (viewport: ViewportTransform) => void;
}) {
  const layout = useMemo(() => layoutGraph(entities), [entities]);
  const positionedById = useMemo(
    () => new Map(layout.nodes.map((node) => [node.entity.id, node])),
    [layout.nodes],
  );
  const drag = useRef<PointerDrag | null>(null);

  function setZoom(nextZoom: number): void {
    onViewportChange({
      ...viewport,
      zoom: clamp(nextZoom, MIN_ZOOM, MAX_ZOOM),
    });
  }

  function handleViewportKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    const panStep = event.shiftKey ? 80 : 32;
    if (event.key === "+" || event.key === "=") {
      event.preventDefault();
      setZoom(viewport.zoom + 0.2);
      return;
    }
    if (event.key === "-") {
      event.preventDefault();
      setZoom(viewport.zoom - 0.2);
      return;
    }
    if (event.key === "0") {
      event.preventDefault();
      onViewportChange({ x: 0, y: 0, zoom: 1 });
      return;
    }
    const movement: readonly [number, number] | undefined = {
      ArrowDown: [0, -panStep] as const,
      ArrowLeft: [panStep, 0] as const,
      ArrowRight: [-panStep, 0] as const,
      ArrowUp: [0, panStep] as const,
    }[event.key];
    if (movement !== undefined) {
      event.preventDefault();
      onViewportChange({
        ...viewport,
        x: viewport.x + movement[0],
        y: viewport.y + movement[1],
      });
    }
  }

  function handlePointerDown(event: PointerEvent<HTMLDivElement>): void {
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = {
      pointerId: event.pointerId,
      clientX: event.clientX,
      clientY: event.clientY,
      originX: viewport.x,
      originY: viewport.y,
    };
  }

  function handlePointerMove(event: PointerEvent<HTMLDivElement>): void {
    const current = drag.current;
    if (current?.pointerId !== event.pointerId) {
      return;
    }
    onViewportChange({
      ...viewport,
      x: current.originX + event.clientX - current.clientX,
      y: current.originY + event.clientY - current.clientY,
    });
  }

  function finishPointerDrag(event: PointerEvent<HTMLDivElement>): void {
    if (drag.current?.pointerId === event.pointerId) {
      drag.current = null;
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }

  function handleWheel(event: WheelEvent<HTMLDivElement>): void {
    event.preventDefault();
    setZoom(viewport.zoom + (event.deltaY < 0 ? 0.12 : -0.12));
  }

  if (entities.length === 0) {
    return (
      <div className="project-graph-canvas project-graph-canvas--empty" role="status">
        当前筛选没有节点。重新勾选节点类型即可恢复。
      </div>
    );
  }

  return (
    <div className="project-graph-visual">
      <div className="project-graph-controls" aria-label="关系图视口控制">
        <Button
          variant="secondary"
          size="sm"
          aria-label="缩小关系图"
          onClick={() => setZoom(viewport.zoom - 0.2)}
        >
          −
        </Button>
        <span aria-live="polite">{Math.round(viewport.zoom * 100)}%</span>
        <Button
          variant="secondary"
          size="sm"
          aria-label="放大关系图"
          onClick={() => setZoom(viewport.zoom + 0.2)}
        >
          ＋
        </Button>
        <Button
          variant="secondary"
          size="sm"
          onClick={() => onViewportChange({ x: 0, y: 0, zoom: 1 })}
        >
          适合画布
        </Button>
      </div>

      <div
        className="project-graph-canvas"
        role="application"
        aria-label="故事关系图画布；方向键平移，加减键缩放，数字 0 适合画布"
        tabIndex={0}
        data-pan-x={Math.round(viewport.x)}
        data-pan-y={Math.round(viewport.y)}
        data-zoom={viewport.zoom.toFixed(2)}
        onKeyDown={handleViewportKeyDown}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={finishPointerDrag}
        onPointerCancel={finishPointerDrag}
        onWheel={handleWheel}
      >
        <svg
          viewBox={`0 0 ${String(layout.width)} ${String(layout.height)}`}
          aria-hidden="true"
          focusable="false"
        >
          <defs>
            <marker
              id="project-graph-arrow"
              markerWidth="8"
              markerHeight="8"
              refX="7"
              refY="4"
              orient="auto"
            >
              <path d="M0,0 L8,4 L0,8 z" />
            </marker>
          </defs>
          <g
            transform={`translate(${String(viewport.x)} ${String(viewport.y)}) scale(${String(
              viewport.zoom,
            )})`}
          >
            {relations.map((relation) => {
              const from = positionedById.get(relation.fromEntityId);
              const to = positionedById.get(relation.toEntityId);
              if (from === undefined || to === undefined) {
                return null;
              }
              const startX = from.x + 190;
              const startY = from.y + 29;
              const endX = to.x;
              const endY = to.y + 29;
              const bend = Math.max(70, Math.abs(endX - startX) / 2);
              const path = `M ${String(startX)} ${String(startY)} C ${String(
                startX + bend,
              )} ${String(startY)}, ${String(endX - bend)} ${String(endY)}, ${String(
                endX,
              )} ${String(endY)}`;
              return (
                <g key={relation.id}>
                  <path
                    className="project-graph-edge"
                    d={path}
                    markerEnd="url(#project-graph-arrow)"
                  />
                  <text
                    className="project-graph-edge-label"
                    x={(startX + endX) / 2}
                    y={(startY + endY) / 2 - 8}
                    textAnchor="middle"
                  >
                    {graphRelationLabel(relation.kind)}
                  </text>
                </g>
              );
            })}
            {layout.nodes.map(({ entity, x, y }) => (
              <g
                key={entity.id}
                className={`project-graph-node${
                  entity.id === selectedEntityId ? " is-selected" : ""
                }`}
                role="button"
                tabIndex={0}
                aria-label={`${graphKindLabel(entity.kind)}：${entity.label}`}
                onClick={(event) => {
                  event.stopPropagation();
                  onSelect(entity.id);
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    event.stopPropagation();
                    onSelect(entity.id);
                  }
                }}
                transform={`translate(${String(x)} ${String(y)})`}
              >
                <rect width="190" height="58" rx="12" />
                <text className="project-graph-node__kind" x="14" y="20">
                  {graphKindLabel(entity.kind)}
                </text>
                <text className="project-graph-node__label" x="14" y="42">
                  {truncateLabel(entity.label)}
                </text>
              </g>
            ))}
          </g>
        </svg>
      </div>

      <GraphMinimap layout={layout} relations={relations} viewport={viewport} />
    </div>
  );
}
/* eslint-enable jsx-a11y/no-noninteractive-element-interactions, jsx-a11y/no-noninteractive-tabindex */

function GraphMinimap({
  layout,
  relations,
  viewport,
}: {
  readonly layout: GraphLayout;
  readonly relations: readonly GraphRelation[];
  readonly viewport: ViewportTransform;
}) {
  const positionedById = new Map(layout.nodes.map((node) => [node.entity.id, node]));
  return (
    <div className="project-graph-minimap" aria-label="关系图小地图">
      <span>小地图</span>
      <svg
        viewBox={`0 0 ${String(layout.width)} ${String(layout.height)}`}
        role="img"
        aria-label={`小地图显示 ${String(layout.nodes.length)} 个节点和 ${String(
          relations.length,
        )} 条边`}
      >
        {relations.map((relation) => {
          const from = positionedById.get(relation.fromEntityId);
          const to = positionedById.get(relation.toEntityId);
          return from === undefined || to === undefined ? null : (
            <line
              key={relation.id}
              x1={from.x + 95}
              y1={from.y + 29}
              x2={to.x + 95}
              y2={to.y + 29}
            />
          );
        })}
        {layout.nodes.map(({ entity, x, y }) => (
          <rect key={entity.id} x={x} y={y} width="190" height="58" rx="8" />
        ))}
        <rect
          className="project-graph-minimap__viewport"
          x={clamp(-viewport.x / viewport.zoom, 0, layout.width)}
          y={clamp(-viewport.y / viewport.zoom, 0, layout.height)}
          width={layout.width / viewport.zoom}
          height={layout.height / viewport.zoom}
        />
      </svg>
    </div>
  );
}

function GraphEntityDetails({
  entity,
  projectId,
  relations,
}: {
  readonly entity: GraphEntity | null;
  readonly relations: readonly GraphRelation[];
  readonly projectId: string;
}) {
  if (entity === null) {
    return (
      <Card className="project-graph-details">
        <CardContent>
          <EmptyState title="未选择节点" description="从画布或等价列表中选择一个节点。" />
        </CardContent>
      </Card>
    );
  }
  const sourceLink = graphEntitySourceLink(entity, projectId);
  return (
    <Card className="project-graph-details">
      <CardHeader>
        <div className="project-graph-details__heading">
          <Badge>{graphKindLabel(entity.kind)}</Badge>
          <CardTitle>{entity.label}</CardTitle>
        </div>
      </CardHeader>
      <CardContent>
        <dl className="project-graph-source-metadata">
          <div>
            <dt>节点 ID</dt>
            <dd>{entity.id}</dd>
          </div>
          <div>
            <dt>来源版本</dt>
            <dd>{entity.source.sourceVersionId}</dd>
          </div>
          <div>
            <dt>内容哈希</dt>
            <dd title={entity.source.contentHash}>{shortHash(entity.source.contentHash)}</dd>
          </div>
          <div>
            <dt>更新时间</dt>
            <dd>{formatTimestamp(entity.updatedAt)}</dd>
          </div>
        </dl>
        {sourceLink !== null && (
          <Link className="button-link button-link--secondary" to={sourceLink.to}>
            {sourceLink.label}
          </Link>
        )}

        <section className="project-graph-evidence" aria-labelledby="graph-evidence-title">
          <div className="section-heading">
            <h3 id="graph-evidence-title">关联证据</h3>
            <Badge>{relations.length} 条边</Badge>
          </div>
          {relations.length === 0 ? (
            <p>当前节点没有仍有效的抽取证据边。</p>
          ) : (
            <ul>
              {relations.map((relation) => (
                <li key={relation.id}>
                  <div className="project-graph-evidence__heading">
                    <strong>{graphRelationLabel(relation.kind)}</strong>
                    <Badge tone="info">人工确认</Badge>
                  </div>
                  <p>
                    {relation.fromEntityId} → {relation.toEntityId}
                  </p>
                  {relation.evidence.map((evidence) => (
                    <figure key={evidence.id}>
                      <blockquote>“{evidence.quote}”</blockquote>
                      <figcaption>
                        {evidence.citation.label} · {evidence.citation.locator} · 版本{" "}
                        {evidence.sourceVersionId}
                      </figcaption>
                    </figure>
                  ))}
                </li>
              ))}
            </ul>
          )}
        </section>
      </CardContent>
    </Card>
  );
}

function AccessibleGraphList({
  entities,
  onSelect,
  relations,
  selectedEntityId,
}: {
  readonly entities: readonly GraphEntity[];
  readonly relations: readonly GraphRelation[];
  readonly selectedEntityId: string | null;
  readonly onSelect: (entityId: string) => void;
}) {
  const degreeByEntity = new Map<string, number>();
  for (const relation of relations) {
    degreeByEntity.set(relation.fromEntityId, (degreeByEntity.get(relation.fromEntityId) ?? 0) + 1);
    degreeByEntity.set(relation.toEntityId, (degreeByEntity.get(relation.toEntityId) ?? 0) + 1);
  }
  return (
    <section className="project-graph-accessible-list" aria-labelledby="graph-list-title">
      <div className="section-heading">
        <div>
          <h2 id="graph-list-title">节点等价列表</h2>
          <p>无需画布操作也可浏览并选择全部当前展示节点。</p>
        </div>
        <Badge>{entities.length} 个节点</Badge>
      </div>
      <ul>
        {entities.map((entity) => (
          <li key={entity.id}>
            <button
              type="button"
              aria-pressed={entity.id === selectedEntityId}
              onClick={() => onSelect(entity.id)}
            >
              <span>
                <Badge>{graphKindLabel(entity.kind)}</Badge>
                <strong>{entity.label}</strong>
              </span>
              <span>{degreeByEntity.get(entity.id) ?? 0} 条关联边</span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

function layoutGraph(entities: readonly GraphEntity[]): GraphLayout {
  const grouped = new Map<string, GraphEntity[]>();
  for (const entity of [...entities].sort(compareEntities)) {
    const current = grouped.get(entity.kind) ?? [];
    current.push(entity);
    grouped.set(entity.kind, current);
  }
  const kinds = [...grouped.keys()].sort(compareGraphKinds);
  const maximumRows = Math.max(1, ...[...grouped.values()].map((items) => items.length));
  const nodes = kinds.flatMap((kind, column) =>
    (grouped.get(kind) ?? []).map((entity, row) => ({
      entity,
      x: 90 + column * 270,
      y: 72 + row * 96,
    })),
  );
  return {
    width: Math.max(920, 180 + kinds.length * 270),
    height: Math.max(520, 150 + maximumRows * 96),
    nodes,
  };
}

function compareEntities(left: GraphEntity, right: GraphEntity): number {
  return (
    compareGraphKinds(left.kind, right.kind) ||
    left.label.localeCompare(right.label) ||
    left.id.localeCompare(right.id)
  );
}

function compareGraphKinds(left: string, right: string): number {
  if (left === "chapter" && right !== "chapter") {
    return -1;
  }
  if (right === "chapter" && left !== "chapter") {
    return 1;
  }
  return left.localeCompare(right);
}

function graphKindLabel(kind: string): string {
  return (
    {
      chapter: "章节",
      character: "角色",
      foreshadow: "伏笔",
      timeline_event: "时间线事件",
      world_rule: "世界规则",
    }[kind] ?? kind
  );
}

function graphRelationLabel(kind: string): string {
  return kind === "extraction_supports" ? "抽取证据支持" : kind;
}

function graphEntitySourceLink(
  entity: GraphEntity,
  projectId: string,
): { readonly label: string; readonly to: string } | null {
  if (entity.documentId?.startsWith("chapter:") === true) {
    return {
      label: "打开来源章节",
      to: `/projects/${projectId}/chapters/${entity.documentId.slice("chapter:".length)}`,
    };
  }
  if (entity.documentId?.startsWith("formal-record:") === true) {
    return {
      label: "打开故事治理",
      to: `/projects/${projectId}/story`,
    };
  }
  return null;
}

function truncateLabel(value: string): string {
  return value.length > 24 ? `${value.slice(0, 23)}…` : value;
}

function shortHash(value: string): string {
  return `${value.slice(0, 10)}…${value.slice(-8)}`;
}

function formatTimestamp(value: string): string {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp)
    ? new Intl.DateTimeFormat("zh-CN", {
        dateStyle: "medium",
        timeStyle: "short",
      }).format(new Date(timestamp))
    : value;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}
