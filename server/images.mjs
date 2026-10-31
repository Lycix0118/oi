const maxImageBytes = 2 * 1024 * 1024;

export function validImages(images, role) {
  if (images === undefined) return true;
  if (
    !Array.isArray(images) ||
    images.length > 4 ||
    (images.length && role !== "user")
  )
    return false;
  return images.every((image) => {
    if (
      !image ||
      typeof image.name !== "string" ||
      image.name.length > 255 ||
      typeof image.dataUrl !== "string" ||
      image.dataUrl.length > Math.ceil(maxImageBytes / 3) * 4 + 40
    )
      return false;
    const match =
      /^data:image\/(png|jpeg|webp|gif);base64,([A-Za-z0-9+/]+={0,2})$/.exec(
        image.dataUrl,
      );
    if (!match || match[2].length % 4 !== 0) return false;
    const bytes = Buffer.from(match[2], "base64");
    if (!bytes.length || bytes.length > maxImageBytes) return false;
    switch (match[1]) {
      case "png":
        return bytes
          .subarray(0, 8)
          .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
      case "jpeg":
        return bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
      case "gif":
        return ["GIF87a", "GIF89a"].includes(bytes.toString("ascii", 0, 6));
      case "webp":
        return (
          bytes.toString("ascii", 0, 4) === "RIFF" &&
          bytes.toString("ascii", 8, 12) === "WEBP"
        );
      default:
        return false;
    }
  });
}

export function modelContent(message) {
  if (!message.images?.length) return message.content;
  return [
    ...(message.content ? [{ type: "text", text: message.content }] : []),
    ...message.images.map((image) => ({
      type: "image_url",
      image_url: { url: image.dataUrl },
    })),
  ];
}
