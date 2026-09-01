export const hello = async (event) => {
  return {
    statusCode: 200,
    body: JSON.stringify({
      message: 'こんにちは！'
    })
  };
};

export const bye = async (event) => {
  return {
    statusCode: 200,
    body: JSON.stringify({
      message: 'さよなら！'
    })
  };
}