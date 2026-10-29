import { describe, expect, it } from 'vitest';
import { staticCtx as c } from './core';
import {
  File_AppendAllText$string_string,
  File_Create$string,
  File_ReadAllText$string,
  Stream_Flush,
  Stream_Seek,
  StreamWriter_set_AutoFlush,
  StreamWriter_WriteLine$string,
  Stream_Write$Byte_arr_int_int,
  new_StreamWriter$Stream,
  new_MemoryStream$Byte_arr,
  new_MemoryStream$Byte_arr_int_int,
  new_BinaryWriter$Stream,
  BinaryWriter_Write$Byte,
  BinaryWriter_Write$int,
} from './dotnetIO';

describe('虛擬檔案系統的寫入（log 一直 append 不整份重拷）', () => {
  it('AppendAllText 接很多次：內容照順序', () => {
    const lines = Array.from({ length: 2000 }, (_, i) => `第 ${i} 行\n`);
    for (const l of lines) File_AppendAllText$string_string(c, '/persistent/a.log', l);
    expect(File_ReadAllText$string(c, '/persistent/a.log')).toBe(lines.join(''));
  });
  it('AutoFlush 的 StreamWriter：每行 flush 後讀得到；覆寫已 flush 的那段，flush 前讀到的還是舊內容', () => {
    const s = File_Create$string(c, '/persistent/b.log');
    const w = new_StreamWriter$Stream(c, s);
    StreamWriter_set_AutoFlush(c, w, true);
    StreamWriter_WriteLine$string(c, w, 'hello');
    StreamWriter_WriteLine$string(c, w, 'world');
    expect(File_ReadAllText$string(c, '/persistent/b.log')).toBe('hello\nworld\n');
    Stream_Seek(c, s, 0, 0);
    Stream_Write$Byte_arr_int_int(c, s, [74, 74], 0, 2);
    expect(File_ReadAllText$string(c, '/persistent/b.log')).toBe('hello\nworld\n');
    Stream_Flush(c, s);
    expect(File_ReadAllText$string(c, '/persistent/b.log')).toBe('JJllo\nworld\n');
  });
});

describe('new MemoryStream(byte[])：包住呼叫端的陣列（不複製）、容量固定', () => {
  it('寫入落在原陣列（一般陣列與 Uint8Array 都是）：MT2 ReplayManager.SerializeEntry 寫完把 recordBytesBuffer 轉 Base64', () => {
    const arr = new Array<number>(8).fill(0);
    const w = new_BinaryWriter$Stream(c, new_MemoryStream$Byte_arr(c, arr));
    BinaryWriter_Write$Byte(c, w, 7);
    BinaryWriter_Write$int(c, w, 0x01020304);
    expect(arr.slice(0, 5)).toEqual([7, 4, 3, 2, 1]);
    const u8 = new Uint8Array(4);
    const s = new_MemoryStream$Byte_arr(c, u8);
    Stream_Write$Byte_arr_int_int(c, s, [9, 8], 0, 2);
    expect(Array.from(u8)).toEqual([9, 8, 0, 0]);
  });
  it('index／count 的版本從 index 開始寫；超過容量丟 NotSupportedException', () => {
    const arr = new Array<number>(6).fill(0);
    const s = new_MemoryStream$Byte_arr_int_int(c, arr, 2, 3);
    Stream_Write$Byte_arr_int_int(c, s, [1, 2, 3], 0, 3);
    expect(arr).toEqual([0, 0, 1, 2, 3, 0]);
    expect(() => Stream_Write$Byte_arr_int_int(c, s, [4], 0, 1)).toThrow(/not expandable/);
  });
});
