import { useMemo, useCallback, useRef, useEffect } from 'preact/hooks'
import {
  ReactFlow,
  useNodesState,
  useEdgesState,
  Handle,
  Position,
} from '@reactflow/core'
import type { Node } from '@reactflow/core'
import { Background } from '@reactflow/background'
import { Controls } from '@reactflow/controls'
import { MiniMap } from '@reactflow/minimap'
import '@reactflow/core/dist/style.css'
import '@reactflow/core/dist/base.css'
import '@reactflow/controls/dist/style.css'
import '@reactflow/minimap/dist/style.css'
import type { MinionSession, DagGraph } from '../types'
import { StatusBadge, AttentionBadge, getStatusColors, getAttentionBorder, formatRelativeTime } from './shared'
import { PrLink } from './PrLink'
import { ContextMenu, useLongPress, useContextMenu } from './ContextMenu'
import type { ContextMenuActions } from './ContextMenu'
import { layoutUniverse } from './universe-layout'
import type { UniverseNode, UniverseEdge } from './universe-layout'
import { useTelegram } from '../hooks'

interface UniverseNodeData {
  session?: MinionSession
  label: string
  status: string
  groupId: string
  nodeType: 'dag' | 'parent-child' | 'standalone'
  isDark: boolean
  onContextMenu: (session: MinionSession, position: { x: number; y: number }) => void
}

function UniverseNodeComponent({ data }: { data: UniverseNodeData }) {
  const tg = useTelegram()
  const isDark = data.isDark
  const session = data.session
  const statusColors = getStatusColors(isDark)
  const status = data.status as keyof ReturnType<typeof getStatusColors>
  const colors = statusColors[status] || statusColors.pending

  const attentionRing = session ? getAttentionBorder(session, isDark) : ''

  const handleContextMenuOpen = useCallback(
    (position: { x: number; y: number }) => {
      if (session) {
        data.onContextMenu(session, position)
      }
    },
    [session, data]
  )

  const longPressHandlers = useLongPress(handleContextMenuOpen, handleContextMenuOpen)

  const handleClick = useCallback(() => {
    if (session?.threadId && session?.chatId) {
      const threadUrl = `https://t.me/c/${String(session.chatId).replace(/^-100/, '')}/${session.threadId}`
      tg.navigation.openTgLink(threadUrl)
    }
  }, [session, tg.navigation])

  const hasThread = Boolean(session?.threadId && session?.chatId)
  const isActive = session?.status === 'running' || session?.status === 'pending'

  const nodeTypeLabel = data.nodeType === 'dag' ? 'DAG' : data.nodeType === 'parent-child' ? 'Tree' : null

  return (
    <div
      onTouchStart={longPressHandlers.onTouchStart}
      onTouchEnd={longPressHandlers.onTouchEnd}
      onTouchMove={longPressHandlers.onTouchMove}
      onContextMenu={longPressHandlers.onContextMenu}
    >
      <Handle type="target" position={Position.Top} style={{ opacity: 0 }} />
      <div
        onClick={hasThread ? handleClick : undefined}
        role={hasThread ? 'button' : undefined}
        tabIndex={hasThread ? 0 : undefined}
        class={`${attentionRing}`}
        data-testid={`universe-node-${session?.id || data.label}`}
        style={{
          width: 240,
          height: 100,
          backgroundColor: colors.bg,
          borderColor: colors.border,
          color: colors.text,
          borderWidth: '2px',
          borderStyle: 'solid',
          borderRadius: '10px',
          padding: '10px 12px',
          cursor: hasThread ? 'pointer' : 'default',
          boxShadow: isActive
            ? `0 0 12px ${colors.border}40`
            : '0 1px 3px rgba(0,0,0,0.1)',
          transition: 'box-shadow 0.2s ease',
          overflow: 'hidden',
        }}
      >
        <div class="flex items-center justify-between gap-1">
          <div class="font-semibold text-sm truncate flex-1">{data.label}</div>
          {nodeTypeLabel && (
            <span
              class="text-[10px] px-1.5 py-0.5 rounded-full font-medium shrink-0"
              style={{
                backgroundColor: isDark ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.06)',
                color: isDark ? 'rgba(255,255,255,0.5)' : 'rgba(0,0,0,0.4)',
              }}
            >
              {nodeTypeLabel}
            </span>
          )}
        </div>

        <div class="flex items-center gap-2 mt-1">
          <StatusBadge status={status} />
          {session?.needsAttention && session.attentionReasons.length > 0 && (
            <AttentionBadge reason={session.attentionReasons[0]} darkMode={isDark} />
          )}
        </div>

        <div class="flex items-center justify-between mt-1">
          {session?.prUrl ? (
            <div onClick={(e: Event) => e.stopPropagation()}>
              <PrLink prUrl={session.prUrl} compact />
            </div>
          ) : session?.branch ? (
            <div class="text-[11px] truncate opacity-60 max-w-[140px]">{session.branch}</div>
          ) : session?.command ? (
            <div class="text-[11px] truncate opacity-60 max-w-[140px]">{session.command}</div>
          ) : (
            <div />
          )}
          {session?.updatedAt && (
            <span class="text-[10px] opacity-40 shrink-0">{formatRelativeTime(session.updatedAt)}</span>
          )}
        </div>
      </div>
      <Handle type="source" position={Position.Bottom} style={{ opacity: 0 }} />
    </div>
  )
}

const nodeTypes = {
  universeNode: UniverseNodeComponent,
}

export interface UniverseCanvasProps {
  sessions: MinionSession[]
  dags: DagGraph[]
  isLoading: boolean
  onSendReply: (sessionId: string, message: string) => Promise<void>
  onStopMinion: (sessionId: string) => Promise<void>
  onCloseSession: (sessionId: string) => Promise<void>
  onOpenThread: (session: MinionSession) => void
  isActionLoading: boolean
}

export function UniverseCanvas({
  sessions,
  dags,
  isLoading,
  onSendReply,
  onStopMinion,
  onCloseSession,
  onOpenThread,
  isActionLoading,
}: UniverseCanvasProps) {
  const tg = useTelegram()
  const isDark = tg.darkMode
  const contextMenu = useContextMenu()
  const prevLayoutRef = useRef<{ nodes: Node[]; edges: UniverseEdge[] } | null>(null)

  const handleNodeContextMenu = useCallback(
    (session: MinionSession, position: { x: number; y: number }) => {
      contextMenu.open(session, position)
    },
    [contextMenu]
  )

  const { nodes: layoutNodes, edges: layoutEdges } = useMemo(() => {
    if (sessions.length === 0 && dags.length === 0) {
      return { nodes: [] as Node[], edges: [] as UniverseEdge[] }
    }
    const result = layoutUniverse(sessions, dags, isDark)
    return result as { nodes: Node[]; edges: UniverseEdge[] }
  }, [sessions, dags, isDark])

  const nodesWithHandlers = useMemo(() => {
    return layoutNodes.map((node) => ({
      ...node,
      data: {
        ...node.data,
        isDark,
        onContextMenu: handleNodeContextMenu,
      },
    }))
  }, [layoutNodes, isDark, handleNodeContextMenu])

  const [nodes, setNodes, onNodesChange] = useNodesState(nodesWithHandlers)
  const [edges, setEdges, onEdgesChange] = useEdgesState(layoutEdges)

  // Sync layout changes when sessions/dags update
  const layoutKey = useMemo(() => {
    return JSON.stringify(sessions.map((s) => `${s.id}:${s.status}:${s.needsAttention}`)) +
      JSON.stringify(dags.map((d) => `${d.id}:${d.status}`))
  }, [sessions, dags])

  useEffect(() => {
    const currentKey = JSON.stringify(nodesWithHandlers.map((n) => n.id)) +
      JSON.stringify(layoutEdges.map((e) => e.id))
    const prevKey = prevLayoutRef.current
      ? JSON.stringify(prevLayoutRef.current.nodes.map((n) => n.id)) +
        JSON.stringify(prevLayoutRef.current.edges.map((e) => e.id))
      : null

    if (currentKey !== prevKey) {
      setNodes(nodesWithHandlers)
      setEdges(layoutEdges)
      prevLayoutRef.current = { nodes: nodesWithHandlers, edges: layoutEdges }
    }
  }, [layoutKey, nodesWithHandlers, layoutEdges, setNodes, setEdges])

  const contextMenuActions: ContextMenuActions = useMemo(
    () => ({
      onSendReply,
      onStopMinion,
      onCloseSession,
      onOpenThread,
      isActionLoading,
    }),
    [onSendReply, onStopMinion, onCloseSession, onOpenThread, isActionLoading]
  )

  const statusColors = getStatusColors(isDark)

  const hintColor = isDark ? 'text-gray-400' : 'text-gray-500'

  if (sessions.length === 0 && dags.length === 0 && !isLoading) {
    return (
      <div class={`flex items-center justify-center h-[60vh] ${hintColor}`}>
        <div class="text-center">
          <div class="text-4xl mb-3 opacity-40">~</div>
          <div class="text-lg font-medium">No active sessions</div>
          <div class="text-sm mt-1 opacity-70">
            Send a /task command in Telegram to get started
          </div>
        </div>
      </div>
    )
  }

  if (isLoading && sessions.length === 0 && dags.length === 0) {
    return (
      <div class={`flex items-center justify-center h-[60vh] ${hintColor}`}>
        <div class="animate-pulse text-lg">Loading universe...</div>
      </div>
    )
  }

  return (
    <div style={{ width: '100%', height: 'calc(100vh - 120px)' }} data-testid="universe-canvas">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        nodeTypes={nodeTypes}
        fitView
        fitViewOptions={{ padding: 0.3 }}
        minZoom={0.1}
        maxZoom={2}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable={false}
        panOnScroll
        zoomOnPinch
      >
        <Background gap={20} size={1} color={isDark ? '#1f2937' : '#f3f4f6'} />
        <Controls
          showInteractive={false}
          style={{ filter: isDark ? 'invert(1)' : undefined }}
        />
        <MiniMap
          nodeColor={(node: Node) => {
            const nodeStatus = node.data?.status as string | undefined
            if (nodeStatus && statusColors[nodeStatus as keyof typeof statusColors]) {
              return statusColors[nodeStatus as keyof typeof statusColors].border
            }
            return '#6b7280'
          }}
          maskColor={isDark ? 'rgba(0,0,0,0.3)' : 'rgba(0,0,0,0.1)'}
          style={{ filter: isDark ? 'invert(0.8) hue-rotate(180deg)' : undefined }}
        />
      </ReactFlow>

      {contextMenu.state.session && contextMenu.state.position && (
        <ContextMenu
          session={contextMenu.state.session}
          position={contextMenu.state.position}
          actions={contextMenuActions}
          onClose={contextMenu.close}
        />
      )}
    </div>
  )
}
