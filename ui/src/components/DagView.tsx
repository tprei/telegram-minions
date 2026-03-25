import { useMemo, useCallback, useState } from 'preact/hooks'
import {
  ReactFlow,
  Node,
  Edge,
  useNodesState,
  useEdgesState,
  MarkerType,
} from '@reactflow/core'
import { Background } from '@reactflow/background'
import { Controls } from '@reactflow/controls'
import { MiniMap } from '@reactflow/minimap'
import dagre from 'dagre'
import type { DagGraph, DagNode } from '../types'
import { StatusBadge } from './SessionList'
import { useTelegram } from '../hooks'

const NODE_WIDTH = 200
const NODE_HEIGHT = 80

type DagNodeStatus = DagNode['status']

function getStatusColors(isDark: boolean): Record<DagNodeStatus, { bg: string; border: string; text: string }> {
  if (isDark) {
    return {
      pending: { bg: '#374151', border: '#6b7280', text: '#e5e7eb' },
      running: { bg: '#1e3a5f', border: '#3b82f6', text: '#93c5fd' },
      completed: { bg: '#064e3b', border: '#22c55e', text: '#86efac' },
      failed: { bg: '#7f1d1d', border: '#ef4444', text: '#fca5a5' },
      skipped: { bg: '#292524', border: '#78716c', text: '#a8a29e' },
    }
  }
  return {
    pending: { bg: '#f3f4f6', border: '#9ca3af', text: '#374151' },
    running: { bg: '#dbeafe', border: '#3b82f6', text: '#1e40af' },
    completed: { bg: '#dcfce7', border: '#22c55e', text: '#166534' },
    failed: { bg: '#fee2e2', border: '#ef4444', text: '#991b1b' },
    skipped: { bg: '#f5f5f4', border: '#a8a29e', text: '#57534e' },
  }
}

function getLayoutedElements(
  nodes: Node[],
  edges: Edge[],
  direction: 'TB' | 'LR' = 'TB'
): { nodes: Node[]; edges: Edge[] } {
  const dagreGraph = new dagre.graphlib.Graph()
  dagreGraph.setDefaultEdgeLabel(() => ({}))

  dagreGraph.setGraph({ rankdir: direction, nodesep: 80, ranksep: 100 })

  nodes.forEach((node) => {
    dagreGraph.setNode(node.id, { width: NODE_WIDTH, height: NODE_HEIGHT })
  })

  edges.forEach((edge) => {
    dagreGraph.setEdge(edge.source, edge.target)
  })

  dagre.layout(dagreGraph)

  const layoutedNodes = nodes.map((node) => {
    const nodeWithPosition = dagreGraph.node(node.id)
    return {
      ...node,
      position: {
        x: nodeWithPosition.x - NODE_WIDTH / 2,
        y: nodeWithPosition.y - NODE_HEIGHT / 2,
      },
    }
  })

  return { nodes: layoutedNodes, edges }
}

function convertDagToFlowElements(
  dag: DagGraph,
  isDark: boolean
): { nodes: Node[]; edges: Edge[] } {
  const statusColors = getStatusColors(isDark)

  const nodes: Node[] = Object.values(dag.nodes).map((dagNode) => ({
    id: dagNode.id,
    type: 'dagNode',
    data: {
      ...dagNode,
      label: dagNode.slug,
      statusColors: statusColors[dagNode.status],
      isDark,
    },
    position: { x: 0, y: 0 },
  }))

  const edges: Edge[] = []
  Object.values(dag.nodes).forEach((dagNode) => {
    dagNode.dependencies.forEach((depId) => {
      edges.push({
        id: `${depId}-${dagNode.id}`,
        source: depId,
        target: dagNode.id,
        type: 'smoothstep',
        animated: dagNode.status === 'running',
        markerEnd: {
          type: MarkerType.ArrowClosed,
          color: isDark ? '#9ca3af' : '#6b7280',
        },
        style: { stroke: isDark ? '#9ca3af' : '#6b7280' },
      })
    })
  })

  return getLayoutedElements(nodes, edges)
}

interface DagNodeProps {
  data: DagNode & {
    label: string
    statusColors: { bg: string; border: string; text: string }
    isDark: boolean
    onNodeClick?: (node: DagNode) => void
  }
}

function DagNodeComponent({ data }: DagNodeProps) {
  const colors = data.statusColors
  const [showTooltip, setShowTooltip] = useState(false)
  const tg = useTelegram()

  const handleClick = useCallback(() => {
    if (data.onNodeClick) {
      data.onNodeClick(data)
    } else if (data.session?.threadId && data.session?.chatId) {
      const threadUrl = `https://t.me/c/${Math.abs(data.session.chatId)}/${data.session.threadId}`
      tg.navigation.openTgLink(threadUrl)
    }
  }, [data, tg.navigation])

  const hasThread = Boolean(data.session?.threadId && data.session?.chatId)

  const tooltipBg = data.isDark ? '#1f2937' : '#1f2937' // Always dark for contrast
  const tooltipColor = '#f9fafb'

  return (
    <div
      class="relative"
      onMouseEnter={() => setShowTooltip(true)}
      onMouseLeave={() => setShowTooltip(false)}
    >
      <div
        onClick={hasThread ? handleClick : undefined}
        role={hasThread ? 'button' : undefined}
        tabIndex={hasThread ? 0 : undefined}
        style={{
          width: NODE_WIDTH,
          height: NODE_HEIGHT,
          backgroundColor: colors.bg,
          borderColor: colors.border,
          color: colors.text,
          borderWidth: '2px',
          borderStyle: 'solid',
          borderRadius: '8px',
          padding: '8px',
          cursor: hasThread ? 'pointer' : 'default',
          boxShadow: showTooltip ? '0 4px 12px rgba(0,0,0,0.15)' : '0 1px 3px rgba(0,0,0,0.1)',
          transition: 'box-shadow 0.2s ease',
        }}
      >
        <div class="font-semibold text-sm truncate">{data.label}</div>
        <div class="mt-1">
          <StatusBadge status={data.status === 'skipped' ? 'pending' : data.status} />
        </div>
        {data.session?.branch && (
          <div class="text-xs mt-1 truncate opacity-75">{data.session.branch}</div>
        )}
      </div>

      {showTooltip && (
        <div
          class="absolute z-10 p-2 text-xs rounded shadow-lg"
          style={{
            backgroundColor: tooltipBg,
            color: tooltipColor,
            width: '220px',
            left: '50%',
            transform: 'translateX(-50%)',
            bottom: '100%',
            marginBottom: '8px',
          }}
        >
          {data.session?.command && (
            <div class="mb-1 truncate">
              <span class="opacity-75">Task:</span> {data.session.command}
            </div>
          )}
          {data.dependencies.length > 0 && (
            <div class="mb-1">
              <span class="opacity-75">Depends on:</span> {data.dependencies.length}
            </div>
          )}
          {data.dependents.length > 0 && (
            <div>
              <span class="opacity-75">Blocks:</span> {data.dependents.length}
            </div>
          )}
          {hasThread && <div class="text-blue-300 mt-1">Click to open thread</div>}
        </div>
      )}
    </div>
  )
}

const nodeTypes = {
  dagNode: DagNodeComponent,
}

interface DagViewProps {
  dag: DagGraph
  onNodeClick?: (node: DagNode) => void
}

export function DagView({ dag, onNodeClick }: DagViewProps) {
  const tg = useTelegram()
  const isDark = tg.darkMode

  const { nodes: initialNodes, edges: initialEdges } = useMemo(() => {
    const { nodes, edges } = convertDagToFlowElements(dag, isDark)

    const nodesWithClickHandler = nodes.map((node) => ({
      ...node,
      data: {
        ...node.data,
        onNodeClick,
      },
    }))

    return { nodes: nodesWithClickHandler, edges }
  }, [dag, onNodeClick, isDark])

  const [nodes, setNodes, onNodesChange] = useNodesState(initialNodes)
  const [edges, setEdges, onEdgesChange] = useEdgesState(initialEdges)

  const onLayout = useCallback(
    (newDirection: 'TB' | 'LR') => {
      const { nodes: layoutedNodes, edges: layoutedEdges } = getLayoutedElements(
        nodes,
        edges,
        newDirection
      )
      setNodes(layoutedNodes)
      setEdges(layoutedEdges)
    },
    [nodes, edges, setNodes, setEdges]
  )

  void onLayout

  const hintColor = isDark ? 'text-gray-400' : 'text-gray-500'

  if (Object.keys(dag.nodes).length === 0) {
    return (
      <div class={`text-center py-8 ${hintColor}`}>
        <div class="text-lg">Empty DAG</div>
        <div class="text-sm mt-1">No tasks in this graph</div>
      </div>
    )
  }

  const statusColors = getStatusColors(isDark)

  return (
    <div style={{ width: '100%', height: '400px' }}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        nodeTypes={nodeTypes}
        fitView
        fitViewOptions={{ padding: 0.2 }}
        minZoom={0.3}
        maxZoom={1.5}
      >
        <Background gap={16} size={1} color={isDark ? '#374151' : '#e5e7eb'} />
        <Controls style={{ filter: isDark ? 'invert(1)' : undefined }} />
        <MiniMap
          nodeColor={(node: Node) => {
            const status = (node.data as { status?: DagNodeStatus })?.status
            return status ? statusColors[status].border : '#6b7280'
          }}
          maskColor={isDark ? 'rgba(0,0,0,0.3)' : 'rgba(0,0,0,0.1)'}
          style={{ filter: isDark ? 'invert(0.8) hue-rotate(180deg)' : undefined }}
        />
      </ReactFlow>
    </div>
  )
}

interface DagListProps {
  dags: DagGraph[]
  isLoading: boolean
  onNodeClick?: (node: DagNode) => void
}

export function DagList({ dags, isLoading, onNodeClick }: DagListProps) {
  const tg = useTelegram()
  const headingColor = tg.darkMode ? 'text-white' : 'text-gray-900'
  const cardBg = tg.darkMode ? 'bg-gray-800' : 'bg-gray-50'
  const hintColor = tg.darkMode ? 'text-gray-400' : 'text-gray-500'

  if (isLoading && dags.length === 0) {
    return (
      <div class="text-center py-8">
        <div class={`animate-pulse ${hintColor}`}>Loading DAGs...</div>
      </div>
    )
  }

  if (dags.length === 0) {
    return null
  }

  return (
    <section class="mt-8">
      <h2 class={`text-lg font-semibold mb-3 ${headingColor}`}>DAG Workflows</h2>
      {dags.map((dag) => (
        <div key={dag.id} class={`${cardBg} rounded-lg p-4 mb-4`}>
          <div class="flex items-center justify-between mb-3">
            <div class="flex items-center gap-2">
              <span class={`font-medium ${headingColor}`}>
                {Object.values(dag.nodes).find((n) => n.id === dag.rootTaskId)?.slug || 'DAG'}
              </span>
              <StatusBadge status={dag.status === 'failed' ? 'failed' : dag.status} />
            </div>
            <span class={`text-xs ${hintColor}`}>
              {Object.values(dag.nodes).length} nodes
            </span>
          </div>
          <DagView dag={dag} onNodeClick={onNodeClick} />
        </div>
      ))}
    </section>
  )
}
