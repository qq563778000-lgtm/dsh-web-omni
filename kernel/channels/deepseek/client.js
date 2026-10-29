/**
 * DeepSeek API 客户端
 *
 * 从 api-client.js 提取的 callDeepSeekAPI 函数
 */

/**
 * 调用 DeepSeek API
 *
 * @param {Object} openaiReq - OpenAI 格式请求
 * @param {Object} options - 选项
 * @param {boolean} options.stream - 是否流式
 * @param {string} options.token - API token
 * @returns {Promise<ReadableStream|Object>} 流式返回 ReadableStream，非流式返回对象
 */
export async function callDeepSeekAPI(openaiReq, options = {}) {
  const { stream = false, token } = options;

  if (!token) {
    throw new Error('DeepSeek API token is required');
  }

  const url = 'https://api.deepseek.com/v1/chat/completions';
  const body = { ...openaiReq, stream };

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`DeepSeek API error ${response.status}: ${error}`);
  }

  if (stream) {
    // 流式：直接返回 ReadableStream
    return response.body;
  } else {
    // 非流式：返回 JSON 对象
    return await response.json();
  }
}
