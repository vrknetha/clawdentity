declare module "jsqr" {
  type JsQrPoint = {
    x: number;
    y: number;
  };

  type JsQrCode = {
    binaryData: number[];
    data: string;
    chunks: unknown[];
    location: {
      topRightCorner: JsQrPoint;
      topLeftCorner: JsQrPoint;
      bottomRightCorner: JsQrPoint;
      bottomLeftCorner: JsQrPoint;
      topRightFinderPattern: JsQrPoint;
      topLeftFinderPattern: JsQrPoint;
      bottomLeftFinderPattern: JsQrPoint;
      bottomRightAlignmentPattern?: JsQrPoint;
    };
  };

  export default function jsQR(
    data: Uint8ClampedArray,
    width: number,
    height: number,
  ): JsQrCode | null;
}
