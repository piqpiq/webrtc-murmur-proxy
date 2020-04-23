"use strict"

export default class PacketDataStream {

  constructor(bufferOrLength, offset) {
    if (typeof bufferOrLength === "number") {
      bufferOrLength = new Uint8Array(bufferOrLength)
    }
    this.reset(bufferOrLength, offset)
  }

  reset(buffer, offset) {
    this.buffer = buffer
    this.offset = offset || 0
    this.length = this.buffer.byteLength
    if (this.offset > this.length) {
      throw new Error("Invalid inital offset for PacketDataStream")
    }
  }

  remaining() {
    return this.length - this.offset
  }

  skip(length) {
    if (this.offset + length > this.buffer.length) {
      throw new Error("Skipping past the end of pds buffer")
    }
    this.offset += length
  }

  putByte(value) {
    if (this.offset >= this.buffer.length) {
      throw new Error("Writing past the end of pds buffer")
    }
    this.buffer[this.offset++] = value
  }

  putInt(value, intLength, offset) {
    if (offset === undefined) {
      offset = this.offset
      this.offset += intLength
    }
    for (let i = intLength; i > 0;) {
        i--
        var byte = value & 0xff;
        this.buffer[offset + i] = byte;
        value = (value - byte) / 256 ;
    }
  }

  putInt16(value, offset) {
    this.putInt(value, 2, offset)
  }
  
  putInt32(value, offset) {
    this.putInt(value, 4, offset)
  }
  
  putVarint(value) {
    if (value < 128) {
      this.buffer[this.offset++] = value
    } else if (value < 16384) {
      this.buffer[this.offset++] = (value / 256) & 255 | 128
      this.buffer[this.offset++] = value & 255
    } else if (value < 2097152) {
      this.buffer[this.offset++] = (value / 65536) & 255 | 192
      this.buffer[this.offset++] = (value / 256) & 255
      this.buffer[this.offset++] = value & 255
    } else if (value < 268435456) {
      this.buffer[this.offset++] = (value / 16777216) & 255 | 224
      this.buffer[this.offset++] = (value / 65536) & 255
      this.buffer[this.offset++] = (value / 256) & 255
      this.buffer[this.offset++] = value & 255
    }
  }

  putBytes(byteArray) {
    if (this.offset + byteArray.byteLength > this.buffer.length) {
      throw new Error("Writing past the end of pds buffer")
    }
    this.buffer.set(byteArray, this.offset)
    this.offset += byteArray.byteLength
  }
  
}
