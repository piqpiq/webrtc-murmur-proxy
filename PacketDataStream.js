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

  getByte() {
    if (this.offset >= this.buffer.length) {
      throw new Error("Reading past the end of pds buffer")
    }
    return this.buffer[this.offset++]
  }

  getInt(intLength, offset) {
    if (offset === undefined) {
      offset = this.offset
      this.offset += intLength
    }
    let result = 0
    for (let i = 0; i < intLength; i++) {
      result = result * 256 + this.buffer[offset++]
    }
    return result
  }

  getInt16(offset) {
    return this.getInt(2, offset)
  }
  
  getInt32(offset) {
    return this.getInt(4, offset)
  }

  getVarint() {
    const firstByte = this.getByte()
    if (firstByte < 128) {
      return firstByte
    } else if ((firstByte & 192) === 128) {
      return (firstByte & 63) * 256 + this.getByte()
    } else if ((firstByte & 224) === 192) {
      return (firstByte & 31) * 65536 + this.getByte() * 256 + this.getByte()
    } else if ((firstByte & 240) === 224) {
      return (firstByte & 15) * 256 * 65536 + this.getByte() * 65536 + this.getByte() * 256 + this.getByte()
    } else if ((firstByte & 252) === 240) {
      return this.getInt(4)
    } else if ((firstByte & 252) === 244) {
      return this.getInt(8)
    } else {
      console.log("UNEXPECTED DATA IN readVarint")
    }
  }

  //Returns the remainder of the buffer
  remainder() {
    return this.buffer.subarray(this.offset)
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

  //Like the TypedArray set, except source must be a TypedArray.  Offset is updated after copy.
  set(source) {
    this.buffer(set, source.buffer, this.offset)
    this.offset += source.byteLength
  }
}
