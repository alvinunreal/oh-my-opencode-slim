import type { PacketV1, ValidatedPacket } from './types';

const PACKET_PATTERNS = [
  /^tldr:?\s*$/im,
  /^evidence:?\s*$/im,
  /^recommendation:?\s*$/im,
  /^next_actions:?\s*$/im,
];

export function extractPacketFromResponse(response: string): PacketV1 | null {
  const packetMatch = response.match(
    /```(?:ya?ml|packet)\s*\n([\s\S]*?)\n```|```\s*\n([\s\S]*?)\n```/,
  );
  if (packetMatch) {
    try {
      const yamlContent = packetMatch[1] || packetMatch[2];
      return parseYamlPacket(yamlContent);
    } catch {
      return null;
    }
  }

  for (const pattern of PACKET_PATTERNS) {
    if (pattern.test(response)) {
      return parseStructuredPacket(response);
    }
  }

  return null;
}

function parseYamlPacket(yaml: string): PacketV1 {
  const lines = yaml.split('\n');
  const result: Partial<PacketV1> = {};
  let currentKey = '';
  let currentArray: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();

    if (trimmed.startsWith('- ')) {
      if (currentKey && currentArray !== null) {
        currentArray.push(trimmed.slice(2));
      }
    } else if (trimmed.includes(':')) {
      if (currentKey && currentArray.length > 0) {
        (result as Record<string, string[]>)[currentKey] = currentArray;
      }

      const [key, ...valueParts] = trimmed.split(':');
      const value = valueParts.join(':').trim();

      if (value) {
        (result as Record<string, string | string[]>)[key.trim()] = value;
        currentKey = '';
        currentArray = [];
      } else {
        currentKey = key.trim();
        currentArray = [];
      }
    }
  }

  if (currentKey && currentArray.length > 0) {
    (result as Record<string, string[]>)[currentKey] = currentArray;
  }

  return {
    tldr: result.tldr ?? [],
    evidence: result.evidence ?? [],
    recommendation: String(result.recommendation ?? ''),
    next_actions: result.next_actions ?? [],
    options: result.options,
    raw_pointers: result.raw_pointers,
  };
}

function parseStructuredPacket(text: string): PacketV1 {
  const sections: Record<string, string[]> = {};
  let currentSection = '';

  for (const line of text.split('\n')) {
    const trimmed = line.trim();

    if (
      /^(tldr|evidence|options|recommendation|next_actions|raw_pointers):?$/i.test(
        trimmed,
      )
    ) {
      currentSection = trimmed.replace(':', '').toLowerCase();
      sections[currentSection] = [];
    } else if (trimmed.startsWith('- ') || trimmed.startsWith('* ')) {
      if (currentSection && sections[currentSection]) {
        sections[currentSection].push(trimmed.slice(2));
      }
    } else if (trimmed && currentSection === 'recommendation') {
      sections[currentSection].push(trimmed);
    }
  }

  return {
    tldr: sections.tldr ?? [],
    evidence: sections.evidence ?? [],
    recommendation: sections.recommendation?.join(' ') ?? '',
    next_actions: sections.next_actions ?? [],
    options: sections.options,
    raw_pointers: sections.raw_pointers,
  };
}

export function formatPacketForContext(packet: ValidatedPacket): string {
  const lines: string[] = [];

  lines.push('## TLDR');
  for (const bullet of packet.tldr) {
    lines.push(`- ${bullet}`);
  }

  lines.push('\n## Evidence');
  for (const bullet of packet.evidence) {
    lines.push(`- ${bullet}`);
  }

  if (packet.options?.length) {
    lines.push('\n## Options');
    for (const bullet of packet.options) {
      lines.push(`- ${bullet}`);
    }
  }

  lines.push('\n## Recommendation');
  lines.push(packet.recommendation);

  lines.push('\n## Next Actions');
  for (const bullet of packet.next_actions) {
    lines.push(`- ${bullet}`);
  }

  return lines.join('\n');
}
