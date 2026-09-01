export const sample = async (event) => {
  return {
    statusCode: 200,
    body: JSON.stringify({
      message: 'サンプルです！'
    })
  };
}