import * as d3 from 'd3';
import { Panel } from './Panel';
import { h, replaceChildren } from '@/utils/dom-utils';
import type { ConvergenceCard, CorrelationDomain } from '@/services/correlation-engine';
import { getHydratedData } from '@/services/bootstrap';

const DOMAINS: CorrelationDomain[] = ['military', 'escalation', 'economic', 'disaster'];

const DOMAIN_COLORS: Record<CorrelationDomain, string> = {
  military:   '#ff4444',
  escalation: '#ff8800',
  economic:   '#4499ff',
  disaster:   '#ff6600',
};

interface NetNode extends d3.SimulationNodeDatum {
  id:     string;
  label:  string;
  weight: number;
  domain: CorrelationDomain;
}

interface NetLink extends d3.SimulationLinkDatum<NetNode> {
  weight: number;
}

export class CorrelationNetworkPanel extends Panel {
  private cardsByDomain = new Map<CorrelationDomain, ConvergenceCard[]>();
  private pendingRender = false;
  private resizeObserver: ResizeObserver | null = null;
  private boundUpdateHandler: EventListener;

  constructor() {
    super({
      id: 'correlation-network',
      title: 'Correlation Network',
      showCount: false,
      infoTooltip:
        'Force-directed graph of entity co-occurrence across all correlation domains. ' +
        'Node size = signal count; edge weight = shared card mentions.',
    });

    const boot =
      (getHydratedData('correlationCards') as Record<string, ConvergenceCard[]> | null) ?? {};
    for (const domain of DOMAINS) {
      const cards = boot[domain];
      if (cards?.length) this.cardsByDomain.set(domain, cards);
    }

    if (this.cardsByDomain.size > 0) {
      this.requestRender();
    } else {
      this.showLoading('Building correlation network…');
    }

    this.boundUpdateHandler = (() => this.requestRender()) as EventListener;
    document.addEventListener('wm:correlation-updated', this.boundUpdateHandler);
  }

  /** Called from App.ts after each engine run with cards from all domains. */
  updateAllCards(cards: ConvergenceCard[]): void {
    this.cardsByDomain.clear();
    for (const card of cards) {
      const list = this.cardsByDomain.get(card.domain) ?? [];
      list.push(card);
      this.cardsByDomain.set(card.domain, list);
    }
    this.requestRender();
  }

  override destroy(): void {
    document.removeEventListener('wm:correlation-updated', this.boundUpdateHandler);
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    super.destroy();
  }

  private requestRender(): void {
    if (this.pendingRender) return;
    this.pendingRender = true;
    requestAnimationFrame(() => {
      this.pendingRender = false;
      this.renderGraph();
    });
  }

  private buildGraph(): { nodes: NetNode[]; links: NetLink[] } {
    const nodeMap = new Map<string, NetNode>();
    const linkMap = new Map<string, { source: string; target: string; weight: number }>();

    for (const [domain, cards] of this.cardsByDomain) {
      for (const card of cards) {
        const entities: string[] = [
          ...(card.countries ?? []).map(c => c.toUpperCase()),
          ...card.signals
            .slice(0, 3)
            .map(s => s.label)
            .filter((l): l is string => typeof l === 'string' && l.length > 0 && l.length < 28),
        ];

        const uniq = [...new Set(entities)];

        for (const eid of uniq) {
          const node = nodeMap.get(eid);
          if (!node) {
            nodeMap.set(eid, { id: eid, label: eid, weight: 1, domain });
          } else {
            node.weight++;
          }
        }

        for (let i = 0; i < uniq.length; i++) {
          for (let j = i + 1; j < uniq.length; j++) {
            const a = uniq[i]!;
            const b = uniq[j]!;
            const key = a < b ? `${a}||${b}` : `${b}||${a}`;
            const lk = linkMap.get(key);
            if (!lk) linkMap.set(key, { source: a, target: b, weight: 1 });
            else lk.weight++;
          }
        }
      }
    }

    const allLinks = [...linkMap.values()]
      .sort((a, b) => b.weight - a.weight)
      .slice(0, 80);

    const used = new Set<string>();
    for (const l of allLinks) { used.add(l.source); used.add(l.target); }

    const nodes = [...nodeMap.values()].filter(n => used.has(n.id));
    return { nodes, links: allLinks as unknown as NetLink[] };
  }

  private renderGraph(): void {
    const { nodes, links } = this.buildGraph();

    if (nodes.length === 0) {
      replaceChildren(
        this.content,
        h('div',
          { style: 'padding:16px;text-align:center;opacity:0.5;font-size:11px;' },
          'Accumulating correlation data…',
        ),
      );
      return;
    }

    const W = this.content.clientWidth || 320;
    const H = Math.round(Math.max(200, Math.min(W * 0.68, 300)));

    // Run force layout synchronously — no DOM animation, pure position calculation.
    d3.forceSimulation<NetNode>(nodes)
      .force(
        'link',
        d3.forceLink<NetNode, NetLink>(links)
          .id(d => d.id)
          .distance(52)
          .strength(0.4),
      )
      .force('charge', d3.forceManyBody<NetNode>().strength(-85))
      .force('center',  d3.forceCenter(W / 2, H / 2))
      .force('collide', d3.forceCollide<NetNode>().radius(d => 8 + d.weight * 2.2))
      .stop()
      .tick(280);

    const NS  = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    svg.setAttribute('width', '100%');
    svg.setAttribute('height', String(H));
    svg.style.cssText =
      'display:block;background:rgba(255,255,255,0.02);border-radius:4px;';

    const gLinks  = document.createElementNS(NS, 'g');
    const gNodes  = document.createElementNS(NS, 'g');
    const gLabels = document.createElementNS(NS, 'g');
    svg.append(gLinks, gNodes, gLabels);

    const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
    const maxW = Math.max(1, ...nodes.map(n => n.weight));
    const labelThreshold = maxW * 0.35;

    for (const link of links) {
      const s  = link.source as NetNode;
      const t2 = link.target as NetNode;
      if (s.x == null || s.y == null || t2.x == null || t2.y == null) continue;
      const line = document.createElementNS(NS, 'line');
      line.setAttribute('x1', String(clamp(s.x,  2, W - 2)));
      line.setAttribute('y1', String(clamp(s.y,  2, H - 2)));
      line.setAttribute('x2', String(clamp(t2.x, 2, W - 2)));
      line.setAttribute('y2', String(clamp(t2.y, 2, H - 2)));
      line.setAttribute(
        'stroke',
        `rgba(255,255,255,${Math.min(0.55, 0.1 + link.weight * 0.1)})`,
      );
      line.setAttribute('stroke-width', String(Math.min(2.5, 0.5 + link.weight * 0.25)));
      gLinks.appendChild(line);
    }

    for (const node of nodes) {
      if (node.x == null || node.y == null) continue;
      const x    = clamp(node.x, 14, W - 14);
      const y    = clamp(node.y, 14, H - 14);
      const r    = Math.min(14, 4 + node.weight * 2);
      const fill = DOMAIN_COLORS[node.domain];

      const circle = document.createElementNS(NS, 'circle');
      circle.setAttribute('cx', String(x));
      circle.setAttribute('cy', String(y));
      circle.setAttribute('r',  String(r));
      circle.setAttribute('fill', fill);
      circle.setAttribute('fill-opacity', '0.82');
      circle.setAttribute('stroke', 'rgba(255,255,255,0.22)');
      circle.setAttribute('stroke-width', '1');

      const titleEl = document.createElementNS(NS, 'title');
      titleEl.textContent = `${node.label} · ${node.weight} signals · ${node.domain}`;
      circle.appendChild(titleEl);
      gNodes.appendChild(circle);

      if (node.weight >= labelThreshold) {
        const txt = document.createElementNS(NS, 'text');
        txt.setAttribute('x', String(x));
        txt.setAttribute('y', String(y + r + 9));
        txt.setAttribute('font-size', '7.5');
        txt.setAttribute('fill', 'rgba(255,255,255,0.78)');
        txt.setAttribute('text-anchor', 'middle');
        txt.setAttribute('pointer-events', 'none');
        txt.textContent =
          node.label.length > 14 ? `${node.label.slice(0, 12)}…` : node.label;
        gLabels.appendChild(txt);
      }
    }

    const legend = h(
      'div',
      { style: 'display:flex;gap:10px;flex-wrap:wrap;padding:4px 6px 2px;font-size:9px;opacity:0.65;' },
      ...Object.entries(DOMAIN_COLORS).map(([domain, color]) =>
        h('span', { style: 'display:flex;align-items:center;gap:3px;' },
          h('span', {
            style: `width:7px;height:7px;border-radius:50%;background:${color};display:inline-block;flex-shrink:0;`,
          }),
          domain,
        ),
      ),
    );

    replaceChildren(this.content, svg, legend);

    this.resizeObserver?.disconnect();
    this.resizeObserver = new ResizeObserver(() => this.requestRender());
    this.resizeObserver.observe(this.content);
  }
}
