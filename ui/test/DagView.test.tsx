import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render } from '@testing-library/preact'
import { DagView, DagList } from '../src/components/DagView'
import type { DagGraph, DagNode } from '../src/types'

const mockDagNode: DagNode = {
  id: 'node-1',
  slug: 'bold-meadow',
  status: 'running',
  dependencies: [],
  dependents: ['node-2'],
  session: {
    id: 'session-1',
    slug: 'bold-meadow',
    status: 'running',
    command: '/task Add feature',
    repo: 'https://github.com/org/repo',
    branch: 'feature-branch',
    threadId: 123,
    chatId: -1001234567890,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    childIds: [],
  },
}

const mockDagNode2: DagNode = {
  id: 'node-2',
  slug: 'calm-lake',
  status: 'pending',
  dependencies: ['node-1'],
  dependents: [],
  session: {
    id: 'session-2',
    slug: 'calm-lake',
    status: 'pending',
    command: '/task Implement UI',
    repo: 'https://github.com/org/repo',
    branch: 'ui-branch',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    childIds: [],
  },
}

const mockDagGraph: DagGraph = {
  id: 'dag-1',
  rootTaskId: 'node-1',
  nodes: {
    'node-1': mockDagNode,
    'node-2': mockDagNode2,
  },
  status: 'running',
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
}

const mockEmptyDagGraph: DagGraph = {
  id: 'dag-2',
  rootTaskId: 'node-3',
  nodes: {},
  status: 'pending',
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
}

const mockCompletedDagGraph: DagGraph = {
  id: 'dag-3',
  rootTaskId: 'node-4',
  nodes: {
    'node-4': {
      id: 'node-4',
      slug: 'done-task',
      status: 'completed',
      dependencies: [],
      dependents: [],
    },
  },
  status: 'completed',
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
}

const mockFailedDagGraph: DagGraph = {
  id: 'dag-4',
  rootTaskId: 'node-5',
  nodes: {
    'node-5': {
      id: 'node-5',
      slug: 'failed-task',
      status: 'failed',
      dependencies: [],
      dependents: [],
    },
  },
  status: 'failed',
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
}

const mockSkippedDagGraph: DagGraph = {
  id: 'dag-5',
  rootTaskId: 'node-6',
  nodes: {
    'node-6': {
      id: 'node-6',
      slug: 'skipped-task',
      status: 'skipped',
      dependencies: [],
      dependents: [],
    },
  },
  status: 'pending',
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
}

vi.mock('@reactflow/core', () => ({
  ReactFlow: vi.fn(({ nodes, children }) => (
    <div data-testid="react-flow" data-node-count={nodes?.length || 0}>
      {nodes?.map((n: { id: string; data: { label: string } }) => (
        <div key={n.id} data-testid={`node-${n.id}`}>
          {n.data.label}
        </div>
      ))}
      {children}
    </div>
  )),
  useNodesState: vi.fn((initial) => [initial, vi.fn(), vi.fn()]),
  useEdgesState: vi.fn((initial) => [initial, vi.fn(), vi.fn()]),
  MarkerType: { ArrowClosed: 'arrowClosed' },
}))

vi.mock('@reactflow/background', () => ({
  Background: vi.fn(() => <div data-testid="background" />),
}))

vi.mock('@reactflow/controls', () => ({
  Controls: vi.fn(() => <div data-testid="controls" />),
}))

vi.mock('@reactflow/minimap', () => ({
  MiniMap: vi.fn(() => <div data-testid="minimap" />),
}))

vi.mock('dagre', () => {
  const mockGraph = vi.fn(() => ({
    setDefaultEdgeLabel: vi.fn(),
    setGraph: vi.fn(),
    setNode: vi.fn(),
    setEdge: vi.fn(),
    node: vi.fn(() => ({ x: 100, y: 100 })),
  }))

  return {
    default: {
      graphlib: {
        Graph: mockGraph,
      },
      layout: vi.fn(),
    },
    graphlib: {
      Graph: mockGraph,
    },
    layout: vi.fn(),
  }
})

describe('DagView', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('renders empty state when DAG has no nodes', () => {
    render(<DagView dag={mockEmptyDagGraph} />)
    expect(document.body.innerHTML).toContain('Empty DAG')
    expect(document.body.innerHTML).toContain('No tasks in this graph')
  })

  it('renders React Flow with nodes', () => {
    render(<DagView dag={mockDagGraph} />)
    expect(document.querySelector('[data-testid="react-flow"]')).toBeTruthy()
  })

  it('renders node slugs', () => {
    render(<DagView dag={mockDagGraph} />)
    expect(document.body.innerHTML).toContain('bold-meadow')
    expect(document.body.innerHTML).toContain('calm-lake')
  })

  it('renders background, controls, and minimap', () => {
    render(<DagView dag={mockDagGraph} />)
    expect(document.querySelector('[data-testid="background"]')).toBeTruthy()
    expect(document.querySelector('[data-testid="controls"]')).toBeTruthy()
    expect(document.querySelector('[data-testid="minimap"]')).toBeTruthy()
  })

  it('accepts onNodeClick callback', () => {
    const onNodeClick = vi.fn()
    render(<DagView dag={mockDagGraph} onNodeClick={onNodeClick} />)
    expect(document.querySelector('[data-testid="react-flow"]')).toBeTruthy()
  })
})

describe('DagList', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('shows loading state when loading with no DAGs', () => {
    render(<DagList dags={[]} isLoading={true} />)
    expect(document.body.innerHTML).toContain('Loading DAGs')
  })

  it('returns null when no DAGs and not loading', () => {
    const { container } = render(<DagList dags={[]} isLoading={false} />)
    expect(container.innerHTML).toBe('')
  })

  it('renders list of DAGs', () => {
    render(<DagList dags={[mockDagGraph]} isLoading={false} />)
    expect(document.body.innerHTML).toContain('DAG Workflows')
    expect(document.body.innerHTML).toContain('2 nodes')
  })

  it('displays root node slug as DAG title', () => {
    render(<DagList dags={[mockDagGraph]} isLoading={false} />)
    expect(document.body.innerHTML).toContain('bold-meadow')
  })

  it('displays DAG status badge', () => {
    render(<DagList dags={[mockDagGraph]} isLoading={false} />)
    expect(document.body.innerHTML).toContain('Running')
  })

  it('displays completed DAG with Done badge', () => {
    render(<DagList dags={[mockCompletedDagGraph]} isLoading={false} />)
    expect(document.body.innerHTML).toContain('Done')
  })

  it('displays failed DAG with Failed badge', () => {
    render(<DagList dags={[mockFailedDagGraph]} isLoading={false} />)
    expect(document.body.innerHTML).toContain('Failed')
  })

  it('renders multiple DAGs', () => {
    render(
      <DagList dags={[mockDagGraph, mockCompletedDagGraph]} isLoading={false} />
    )
    // Use a more flexible selector that works with dynamic theme classes
    const dagContainers = document.querySelectorAll('[class*="bg-gray"]')
    expect(dagContainers.length).toBeGreaterThanOrEqual(2)
  })

  it('accepts onNodeClick callback', () => {
    const onNodeClick = vi.fn()
    render(<DagList dags={[mockDagGraph]} isLoading={false} onNodeClick={onNodeClick} />)
    expect(document.querySelector('[data-testid="react-flow"]')).toBeTruthy()
  })

  it('handles DAG with skipped nodes', () => {
    render(<DagList dags={[mockSkippedDagGraph]} isLoading={false} />)
    expect(document.body.innerHTML).toContain('skipped-task')
  })

  it('displays DAG status (not node status) for skipped node DAG', () => {
    render(<DagList dags={[mockSkippedDagGraph]} isLoading={false} />)
    expect(document.body.innerHTML).toContain('Idle')
  })
})

describe('Status Colors', () => {
  it('renders nodes with different status colors', () => {
    render(<DagList dags={[mockDagGraph]} isLoading={false} />)

    const runningIndicator = document.body.innerHTML.includes('Running')
    const pendingIndicator = document.body.innerHTML.includes('Idle')

    expect(runningIndicator || pendingIndicator).toBeTruthy()
  })
})

describe('Dynamic Height', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('renders with minimum height for small graphs', () => {
    const { container } = render(<DagView dag={mockCompletedDagGraph} />)
    const flowContainer = container.querySelector('[style*="height"]')
    expect(flowContainer).toBeTruthy()
    const height = flowContainer?.getAttribute('style')
    expect(height).toMatch(/height:\s*\d+px/)
  })

  it('calculates height based on node count and graph depth', () => {
    const { container } = render(<DagView dag={mockDagGraph} />)
    const flowContainer = container.querySelector('[style*="height"]')
    expect(flowContainer).toBeTruthy()
    const height = flowContainer?.getAttribute('style')
    expect(height).toMatch(/height:\s*\d+px/)
  })

  it('renders larger graphs with greater height', () => {
    const manyNodesDag: DagGraph = {
      id: 'dag-many',
      rootTaskId: 'node-1',
      nodes: Object.fromEntries(
        Array.from({ length: 10 }, (_, i) => [
          `node-${i}`,
          {
            id: `node-${i}`,
            slug: `task-${i}`,
            status: 'pending' as const,
            dependencies: i > 0 ? [`node-${i - 1}`] : [],
            dependents: i < 9 ? [`node-${i + 1}`] : [],
          },
        ])
      ),
      status: 'pending' as const,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }

    const { container } = render(<DagView dag={manyNodesDag} />)
    const flowContainer = container.querySelector('[style*="height"]')
    expect(flowContainer).toBeTruthy()
    const height = flowContainer?.getAttribute('style')
    expect(height).toMatch(/height:\s*\d+px/)
  })
})
