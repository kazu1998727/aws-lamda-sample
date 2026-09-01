exports.hello = async (event) => {
  return {
    statusCode: 200,
    body: JSON.stringify({
      message: 'こんにちは！'
    })
  };
};

exports.bye = async (event) => {
  return {
    statusCode: 200,
    body: JSON.stringify({
      message: 'さよなら！'
    })
  };
}