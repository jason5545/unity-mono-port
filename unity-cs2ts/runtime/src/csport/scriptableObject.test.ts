import { afterAll, describe, expect, it } from 'vitest';
import { materializeScriptableObject, registerGen, setObjectStore, type Ctx, type GenClassImpl } from './core';
import { ObjectStore } from '../unity/objectStore';

// 跟 Timeline 的 .playable 同一個形狀：主物件（TimelineAsset）的 m_Tracks 指向同檔的子物件（track），track 的 m_Parent 指回主物件；
// track 的 OnAfterDeserialize 經由 parent 碰主物件（Timeline 的 Invalidate），主物件沒有 m_Tracks 時會補空清單
const seen: string[] = [];
const Asset: GenClassImpl = {
  name: 'TestTimeline',
  file: 'TestTimeline.cs',
  initAi: (c: Ctx) => ({ m_Tracks: 'm_Tracks' in c.ed ? c.ed.m_Tracks : [] }),
  serialized: ['m_Tracks'],
  overrides: {},
  delegates: {},
  methods: {
    OnAfterDeserialize: (c: Ctx) => void seen.push(`asset.OnAfterDeserialize tracks=${(c.ai.m_Tracks as unknown[]).length}`),
    OnEnable: () => void seen.push('asset.OnEnable'),
  },
};
const Track: GenClassImpl = {
  name: 'TestTrack',
  file: 'TestTrack.cs',
  initAi: (c: Ctx) => ({ m_Parent: 'm_Parent' in c.ed ? c.ed.m_Parent : null }),
  serialized: ['m_Parent'],
  overrides: {},
  delegates: {},
  methods: {
    OnAfterDeserialize: (c: Ctx) => {
      const parent = c.ai.m_Parent as Record<string, unknown>;
      if (parent.m_Tracks == null) parent.m_Tracks = [];
      seen.push(`track.OnAfterDeserialize parentTracks=${(parent.m_Tracks as unknown[]).length}`);
    },
    OnEnable: () => void seen.push('track.OnEnable'),
  },
};
registerGen({ TestTimeline: Asset, TestTrack: Track });

const GUID = '0123456789abcdef0123456789abcdef';
const store = new ObjectStore('./', { scenes: {}, prefabs: {} }, { [GUID]: { name: 'T', src: 'T.playable', kind: null, script: 'TestTimeline', file: 'objects/x.json' } });
(store as unknown as { soData: Map<string, unknown> }).soData.set(GUID, {
  src: 'T.playable',
  fileID: '11400000',
  m_Name: 'T',
  m_Tracks: [{ fileID: '42' }],
  $subObjects: { '42': { $script: 'TestTrack', m_Name: 'Track', m_Parent: { fileID: '11400000' } } },
});
afterAll(() => setObjectStore(null));

describe('ScriptableObject 的實體化：同檔子物件、互相參照、回呼的順序', () => {
  it('欄位全部填好之後才跑 OnAfterDeserialize，再跑 OnEnable', () => {
    setObjectStore(store);
    const asset = materializeScriptableObject(GUID)!;
    const tracks = asset.m_Tracks as Record<string, unknown>[];
    expect(tracks).toHaveLength(1);
    expect(tracks[0].$type).toBe('TestTrack');
    expect(tracks[0].$fileID).toBe('42');
    expect(tracks[0].m_Parent).toBe(asset);
    expect(materializeScriptableObject(GUID, '42')).toBe(tracks[0]);
    expect(seen).toEqual(['track.OnAfterDeserialize parentTracks=1', 'asset.OnAfterDeserialize tracks=1', 'track.OnEnable', 'asset.OnEnable']);
  });
});
