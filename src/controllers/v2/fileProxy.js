import fileProxyService from '../../services/v2/fileProxy.js';

const getPublicFileContent = async (req, res, next) => {
  try {
    const result = await fileProxyService.getPublicFileContent({ 
      params: req.params,
      headers: req.headers 
    });
    
    // Set appropriate headers for file streaming
    res.set({
      'Content-Type': result.contentType || 'application/octet-stream',
      'Content-Length': result.contentLength,
      'Content-Disposition': `inline; filename="${result.fileName}"`,
      'Cache-Control': 'private, max-age=3600',
    });

    // Stream the file content
    if (result.stream) {
      result.stream.pipe(res);
    } else if (result.buffer) {
      res.send(result.buffer);
    } else {
      res.status(404).json({
        status: 0,
        message: 'file_content_not_available',
        messageElements: [],
      });
    }
  } catch (error) {
    next(error);
  }
};

export default {
  getPublicFileContent,
};
