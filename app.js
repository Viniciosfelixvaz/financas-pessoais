// app.js

require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const { Configuration, OpenAIApi } = require('openai');
const admin = require('firebase-admin');
const axios = require('axios');

// Inicialização do Firebase
const serviceAccount = require('./firebaseServiceAccountKey.json');

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const db = admin.firestore();

// Configuração da OpenAI
const configuration = new Configuration({
  apiKey: process.env.OPENAI_API_KEY,
});
const openai = new OpenAIApi(configuration);

const app = express().use(bodyParser.json());

// Recebimento de Mensagens da Z-API
app.post('/webhook', async (req, res) => {
  try {
    const body = req.body;

    // Verificar se é um callback de mensagem recebida
    if (body.type === 'ReceivedCallback') {
      const isGroup = body.isGroup;
      const fromMe = body.fromMe;
      const phone = body.phone; // Número do remetente ou do grupo
      const senderPhone = body.participantPhone || body.phone; // Número do remetente real

      // Ignorar mensagens enviadas pelo próprio bot
      if (fromMe) {
        return res.sendStatus(200);
      }

      // Extrair o conteúdo da mensagem
      let messageContent = '';

      if (body.text && body.text.message) {
        // Mensagem de texto
        messageContent = body.text.message;
      } else if (body.image && body.image.caption) {
        // Mensagem de imagem com legenda
        messageContent = body.image.caption;
      } else if (body.video && body.video.caption) {
        // Mensagem de vídeo com legenda
        messageContent = body.video.caption;
      } else {
        // Outros tipos de mensagem podem ser tratados aqui
        messageContent = '[Mensagem não suportada]';
      }

      console.log(`Mensagem recebida de ${senderPhone}: ${messageContent}`);

      // Identificar ou criar usuário
      let user = await getUserByPhoneNumber(senderPhone);
      if (!user) {
        user = await createUser(senderPhone);
        console.log('Novo usuário criado:', user.id);
      }

      // Salvar mensagem recebida no Firestore
      await saveMessage(user.id, messageContent, 'received');

      // Enviar mensagem para o ChatGPT
      const assistantResponse = await processMessageWithChatGPT(user, messageContent);

      // Enviar resposta ao usuário
      if (assistantResponse) {
        await sendMessage(senderPhone, assistantResponse);

        // Salvar mensagem enviada no Firestore
        await saveMessage(user.id, assistantResponse, 'sent');
      }

      res.status(200).send('EVENT_RECEIVED');
    } else {
      res.sendStatus(404);
    }
  } catch (error) {
    console.error('Erro no webhook:', error);
    res.sendStatus(500);
  }
});

// Função para processar a mensagem com o ChatGPT
async function processMessageWithChatGPT(user, userMessage) {
  const messages = [
    {
      role: 'system',
      content: 'Você é um assistente financeiro pessoal que ajuda os usuários a gerenciar suas finanças.',
    },
    {
      role: 'user',
      content: userMessage,
    },
  ];

  // Definição das funções que o ChatGPT pode chamar
  const functions = [
    {
      name: 'create_purchase',
      description: 'Cria uma nova compra para o usuário.',
      parameters: {
        type: 'object',
        properties: {
          amount: { type: 'number', description: 'Valor da compra' },
          category: { type: 'string', description: 'Categoria da compra' },
          date: { type: 'string', description: 'Data da compra no formato YYYY-MM-DD' },
          description: { type: 'string', description: 'Descrição da compra' },
        },
        required: ['amount', 'category'],
      },
    },
    {
      name: 'edit_purchase',
      description: 'Edita uma compra existente.',
      parameters: {
        type: 'object',
        properties: {
          purchase_id: { type: 'string', description: 'ID da compra a ser editada' },
          amount: { type: 'number', description: 'Novo valor da compra' },
          category: { type: 'string', description: 'Nova categoria' },
          date: { type: 'string', description: 'Nova data da compra no formato YYYY-MM-DD' },
          description: { type: 'string', description: 'Nova descrição' },
        },
        required: ['purchase_id'],
      },
    },
    // Outras funções podem ser adicionadas aqui
  ];

  try {
    const response = await openai.createChatCompletion({
      model: process.env.OPENAI_MODEL,
      messages,
      functions,
      function_call: 'auto',
    });

    const assistantMessage = response.data.choices[0].message;

    if (assistantMessage.function_call) {
      // O ChatGPT solicitou a chamada de uma função
      const functionName = assistantMessage.function_call.name;
      const functionArgs = JSON.parse(assistantMessage.function_call.arguments);

      console.log(`O assistente solicitou a chamada da função ${functionName}`);

      // Executar a função (por enquanto, placeholders)
      const functionResponse = await executeFunction(user, functionName, functionArgs);

      // Enviar o resultado da função de volta ao ChatGPT
      messages.push(assistantMessage);
      messages.push({
        role: 'function',
        name: functionName,
        content: JSON.stringify(functionResponse),
      });

      // Obter a resposta final do ChatGPT
      const finalResponse = await openai.createChatCompletion({
        model: process.env.OPENAI_MODEL,
        messages,
      });

      const finalAssistantMessage = finalResponse.data.choices[0].message;

      return finalAssistantMessage.content;
    } else {
      // Resposta direta do assistente
      return assistantMessage.content;
    }
  } catch (error) {
    console.error('Erro ao processar a mensagem com o ChatGPT:', error);
    return 'Desculpe, ocorreu um erro ao processar sua mensagem.';
  }
}

// Função para executar a função solicitada pelo ChatGPT
async function executeFunction(user, functionName, functionArgs) {
  // Aqui, você pode integrar com o Google Cloud Functions
  // Por enquanto, usaremos funções placeholder
  switch (functionName) {
    case 'create_purchase':
      // Lógica para criar uma nova compra
      // Exemplo:
      return { status: 'success', message: 'Compra criada com sucesso.' };

    case 'edit_purchase':
      // Lógica para editar uma compra existente
      return { status: 'success', message: 'Compra editada com sucesso.' };

    // Outras funções podem ser tratadas aqui

    default:
      return { status: 'error', message: 'Função não reconhecida.' };
  }
}

// Função para enviar uma mensagem ao usuário via Z-API
async function sendMessage(to, message) {
  const url = `${process.env.ZAPI_BASE_URL}/send-text`;

  const data = {
    phone: to,
    message: message,
  };

  try {
    await axios.post(url, data, {
      headers: {
        'Content-Type': 'application/json',
        // Inclua aqui a autenticação necessária para a Z-API, por exemplo:
        'Authorization': `Bearer ${process.env.ZAPI_TOKEN}`,
      },
    });

    console.log('Mensagem enviada com sucesso para', to);
  } catch (error) {
    console.error('Erro ao enviar mensagem:', error.response ? error.response.data : error);
  }
}

// Função para obter um usuário pelo número de telefone
async function getUserByPhoneNumber(phoneNumber) {
  try {
    const snapshot = await db.collection('users').where('phoneNumber', '==', phoneNumber).get();
    if (!snapshot.empty) {
      const doc = snapshot.docs[0];
      return { id: doc.id, ...doc.data() };
    } else {
      return null;
    }
  } catch (error) {
    console.error('Erro ao obter usuário:', error);
    return null;
  }
}

// Função para criar um novo usuário
async function createUser(phoneNumber) {
  try {
    const newUser = {
      phoneNumber,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      // Outras informações do usuário...
    };
    const docRef = await db.collection('users').add(newUser);
    return { id: docRef.id, ...newUser };
  } catch (error) {
    console.error('Erro ao criar usuário:', error);
    return null;
  }
}

// Função para salvar mensagens no Firestore
async function saveMessage(userId, messageContent, messageType) {
  try {
    await db.collection('messages').add({
      userId,
      content: messageContent,
      type: messageType, // 'received' ou 'sent'
      timestamp: admin.firestore.FieldValue.serverTimestamp(),
    });
    console.log(`Mensagem ${messageType} salva no Firestore.`);
  } catch (error) {
    console.error('Erro ao salvar mensagem:', error);
  }
}

// Iniciar o servidor
app.listen(process.env.PORT || 3000, () => {
  console.log(`Servidor rodando na porta ${process.env.PORT || 3000}`);
});
